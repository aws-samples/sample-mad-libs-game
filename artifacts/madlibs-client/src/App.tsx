import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useGetConfig,
  useJoinGame,
  usePollGame,
  useSubmitWord,
  type PlayerCredentials,
  type PollResponse,
  type RoundPart,
  type Stats,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient();
const POLL_MS = 1000;
const NAME_STORAGE_KEY = 'madlibs-display-name';
const TOKEN_STORAGE_KEY = 'madlibs-join-code';
const SERVER_STORAGE_KEY = 'madlibs-server-url';
const KEY_STORAGE_KEY = 'madlibs-player-key';
const HISTORY_STORAGE_KEY = 'madlibs-history';

type PlayedWord = { word: string; hint?: string; at: number };

// The server keeps no session, so the browser owns the credentials and sends
// them with every call.
function getCredentials(): PlayerCredentials | null {
  const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  const displayName = window.localStorage.getItem(NAME_STORAGE_KEY);
  const gameServerUrl = window.localStorage.getItem(SERVER_STORAGE_KEY);
  const playerKey = window.localStorage.getItem(KEY_STORAGE_KEY);
  if (!token || !displayName || !gameServerUrl || !playerKey) return null;
  return { token, displayName, gameServerUrl, playerKey };
}

function setCredentials(credentials: PlayerCredentials) {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, credentials.token);
  window.localStorage.setItem(NAME_STORAGE_KEY, credentials.displayName);
  window.localStorage.setItem(SERVER_STORAGE_KEY, credentials.gameServerUrl);
  window.localStorage.setItem(KEY_STORAGE_KEY, credentials.playerKey);
}

function readHistory(): PlayedWord[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PlayedWord[]) : [];
  } catch {
    return [];
  }
}

function appendHistory(entry: PlayedWord): PlayedWord[] {
  const words = [...readHistory(), entry].slice(-50);
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(words));
  return words;
}

function apiError(error: unknown, fallback: string) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as {
      data?: { error?: string };
      response?: { data?: { error?: string } };
      message?: string;
    };
    return record.data?.error || record.response?.data?.error || record.message || fallback;
  }
  return fallback;
}

function apiStatus(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { status?: number; response?: { status?: number } };
  return record.status || record.response?.status;
}

function makePlayerKey() {
  const stored = window.localStorage.getItem(KEY_STORAGE_KEY);
  if (stored) return stored;
  const next = window.crypto?.randomUUID?.() || `player-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(KEY_STORAGE_KEY, next);
  return next;
}

function epochMs(value?: number | null) {
  if (!value) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-[100dvh] px-4 py-5 text-foreground sm:px-6 sm:py-7">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">{children}</div>
    </main>
  );
}

function BrandBar({
  joinedName,
  deployed,
  onEdit,
}: {
  joinedName?: string;
  deployed?: boolean;
  onEdit?: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-[14px] border-2 border-primary bg-primary text-sm font-extrabold tracking-[-0.08em] text-primary-foreground shadow-sm">
          ML
        </div>
        <div>
          <p className="display-face text-lg font-extrabold leading-none">madlibs</p>
          <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">live word game</p>
        </div>
      </div>
      {joinedName && onEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {deployed === undefined ? null : <StatusBadge deployed={deployed} />}
          <button
            type="button"
            onClick={onEdit}
            data-testid="button-edit-join"
            className="focus-ring rounded-full border border-border bg-card px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground"
          >
            Change details
          </button>
        </div>
      ) : (
        <div className="hidden items-center gap-2 text-xs font-bold text-muted-foreground sm:flex">
          <span className="h-2 w-2 rounded-full bg-accent" />
          Word game companion
        </div>
      )}
    </header>
  );
}

function JoinScreen({ onJoined }: { onJoined: (result: { name: string }) => void }) {
  const config = useGetConfig();
  const joinGame = useJoinGame();
  const [token, setToken] = useState(() => window.localStorage.getItem(TOKEN_STORAGE_KEY) || '');
  const [displayName, setDisplayName] = useState(() => window.localStorage.getItem(NAME_STORAGE_KEY) || '');
  const [gameServerUrl, setGameServerUrl] = useState(() => window.localStorage.getItem(SERVER_STORAGE_KEY) || '');
  const [formError, setFormError] = useState('');

  const configApplied = useRef(false);
  useEffect(() => {
    const configured = config.data?.gameServerUrl;
    if (!configured || configApplied.current) return;
    configApplied.current = true;
    if (configured !== gameServerUrl) setGameServerUrl(configured);
  }, [config.data?.gameServerUrl, gameServerUrl]);

  const isReady = token.trim().length > 0 && displayName.trim().length > 0 && gameServerUrl.trim().length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isReady) {
      setFormError('Enter the join code, your name, and the game server address.');
      return;
    }
    setFormError('');
    const credentials: PlayerCredentials = {
      token: token.trim(),
      displayName: displayName.trim(),
      gameServerUrl: gameServerUrl.trim(),
      playerKey: makePlayerKey(),
    };
    joinGame.mutate(
      { data: credentials },
      {
        onSuccess: (result) => {
          if (!result.ok || !result.player) {
            setFormError('The game server did not accept the join request. Check the join code and try again.');
            return;
          }
          setCredentials(credentials);
          onJoined({ name: result.player.displayName });
        },
        onError: (error) => setFormError(apiError(error, 'The game server could not be reached. Check the address and try again.')),
      },
    );
  }

  return (
    <Shell>
      <BrandBar />
      <section className="grid items-center gap-10 pb-4 pt-5 md:grid-cols-[1fr_0.78fr] md:gap-16 md:pt-12">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-xs font-extrabold uppercase tracking-[0.14em] text-secondary-foreground">
            <span className="h-2 w-2 rounded-full bg-primary" />
            Ready when the game is
          </p>
          <h1 className="display-face max-w-xl text-[clamp(2.25rem,6vw,4rem)] font-extrabold leading-[1.08] text-foreground">
            Give the story
            <span className="block text-primary">a better word.</span>
          </h1>
          <p className="mt-6 max-w-md text-base leading-7 text-muted-foreground sm:text-lg">
            You get one blank per round and one chance to fill it — a small part in a very strange story.
          </p>
          <div className="mt-8 flex items-center gap-3 text-xs font-bold text-muted-foreground">
            <div className="flex -space-x-2">
              {['A', 'J', 'R'].map((letter) => (
                <span key={letter} className="grid h-8 w-8 place-items-center rounded-full border-2 border-background bg-card text-[11px] text-primary shadow-sm">
                  {letter}
                </span>
              ))}
            </div>
            <span>One blank each. No takebacks.</span>
          </div>
        </div>

        <form onSubmit={submit} className="rounded-[28px] border border-card-border bg-card p-5 shadow-md sm:p-7">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-primary">Join a game</p>
              <h2 className="mt-2 display-face text-2xl font-extrabold">Find your blank.</h2>
            </div>
            <span className="mono-face rounded-lg bg-muted px-2 py-1.5 text-[10px] font-medium text-muted-foreground">01 / 01</span>
          </div>

          <div className="space-y-5">
            <label className="block">
              <span className="mb-2 block text-sm font-bold">Join code</span>
              <input
                value={token}
           onChange={(event) => setToken(event.target.value.toUpperCase())}
                placeholder="e.g. CANDLE-7"
                autoComplete="off"
                data-testid="input-join-code"
                className="focus-ring h-14 w-full rounded-2xl border border-input bg-background px-4 text-lg font-bold uppercase tracking-[0.08em] outline-none placeholder:font-medium placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground/70"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-bold">Your display name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="What should we call you?"
                maxLength={24}
                autoComplete="name"
                data-testid="input-display-name"
                className="focus-ring h-14 w-full rounded-2xl border border-input bg-background px-4 text-base outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <label className="block">
              <span className="mb-2 flex items-center justify-between text-sm font-bold">
                Game server
                {config.isLoading ? <span className="text-xs font-medium text-muted-foreground">Checking…</span> : null}
              </span>
              <input
                value={gameServerUrl}
                onChange={(event) => setGameServerUrl(event.target.value)}
                 placeholder="Enter the game server address"
                type="url"
                data-testid="input-server-url"
                className="focus-ring h-14 w-full rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground/70"
              />
            </label>
          </div>

          {(formError || config.isError) && (
            <div role="alert" data-testid="status-join-error" className="mt-5 rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm font-semibold leading-6 text-destructive">
              {formError || 'The configured server address could not be loaded. You can enter it manually.'}
            </div>
          )}

          <button
            type="submit"
             disabled={!isReady || joinGame.isPending}
            data-testid="button-join-game"
            className="focus-ring mt-6 flex h-14 w-full items-center justify-between rounded-2xl bg-primary px-5 text-left font-extrabold text-primary-foreground shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{joinGame.isPending ? 'Checking…' : 'Join the game'}</span>
            <span className="text-2xl leading-none">→</span>
          </button>
          <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">Your name is visible to other players.</p>
        </form>
      </section>
    </Shell>
  );
}

function StatusBadge({ deployed }: { deployed: boolean }) {
  const tone = deployed ? 'green' : 'orange';
  const label = deployed ? 'Deployed' : 'Running locally — not deployed yet';
  return (
    <span data-testid="status-player" className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-extrabold ${
      tone === 'green' ? 'bg-emerald-50 text-emerald-700' : 'bg-orange-50 text-orange-700'
    }`}>
      <span className={`h-2 w-2 rounded-full ${tone === 'green' ? 'bg-emerald-500' : 'bg-orange-500'}`} />
      {label}
    </span>
  );
}

function Countdown({ endsAt, now }: { endsAt?: number | null; now: number }) {
  const end = epochMs(endsAt);
  if (!end) return <span className="mono-face text-3xl font-medium text-muted-foreground">—</span>;
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));
  return (
    <span data-testid="text-countdown" className={`mono-face text-3xl font-medium ${remaining <= 10 ? 'text-orange-600' : 'text-foreground'}`}>
      {remaining}s
    </span>
  );
}

function Story({ parts }: { parts: RoundPart[] }) {
  if (!parts.length) return null;
  return (
    <p data-testid="content-story" className="text-[17px] leading-[1.9] text-muted-foreground sm:text-lg">
      {parts.map((part, index) => {
        const isBlank = part.kind.toLowerCase().includes('blank') || (part.index !== null && part.index !== undefined);
        if (isBlank) {
          return (
            <span key={`${part.index}-${index}`} className={`mx-1 font-bold underline decoration-2 underline-offset-4 ${part.filler ? 'italic text-orange-700 decoration-orange-400' : 'text-foreground decoration-primary'}`}>
              {part.word || '________'}
            </span>
          );
        }
        return <span key={`${part.text}-${index}`}>{part.text || ''}</span>;
      })}
    </p>
  );
}

function StatStrip({ stats }: { stats?: Stats }) {
  const items = [
    ['Deployed', stats ? `${stats.deployed}/${stats.players}` : '—'],
    ['Active', stats?.active ?? '—'],
    ['Local', stats?.local ?? '—'],
  ];
  return (
    <div data-testid="content-stats" className="grid grid-cols-3 divide-x divide-border rounded-2xl border border-border bg-card py-4 shadow-sm">
      {items.map(([label, value]) => (
        <div key={label} className="px-2 text-center sm:px-4">
          <p className="mono-face text-lg font-medium text-foreground sm:text-xl">{value}</p>
          <p className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.11em] text-muted-foreground">{label}</p>
        </div>
      ))}
    </div>
  );
}

function GameScreen({
  name,
  onEdit,
  onSessionEnded,
}: {
  name: string;
  onEdit: () => void;
  onSessionEnded: () => void;
}) {
  const pollGame = usePollGame();
  const submitWord = useSubmitWord();
  const [recentWords, setRecentWords] = useState<PlayedWord[]>(() => readHistory());
  const [word, setWord] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [lastPollFailure, setLastPollFailure] = useState<{ message: string; status?: number } | null>(null);
  const credentialsRef = useRef(getCredentials());
  const pollRef = useRef(pollGame.mutate);
  const submitRef = useRef(submitWord.mutate);
  const onSessionEndedRef = useRef(onSessionEnded);
  const [poll, setPoll] = useState<PollResponse | undefined>();
  const previousRoundId = useRef<string | null>(null);

  pollRef.current = pollGame.mutate;
  submitRef.current = submitWord.mutate;
  onSessionEndedRef.current = onSessionEnded;

  useEffect(() => {
    const tick = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const credentials = credentialsRef.current;
    if (!credentials) {
      onSessionEndedRef.current();
      return;
    }

    // Schedule the next poll only once the previous one settles, so a slow
    // request cannot stack another on top of it.
    let timer = 0;
    let stopped = false;

    const request = () => pollRef.current({ data: credentials }, {
      onSuccess: (result) => {
        setPoll(result);
        if (!result.ok) {
          setLastPollFailure({ message: result.error || 'The game server returned an invalid state.' });
        } else {
          setLastPollFailure(null);
        }
      },
      onError: (error) => {
        setLastPollFailure({ message: apiError(error, 'The game server is unreachable.'), status: apiStatus(error) });
      },
      onSettled: () => {
        if (!stopped) timer = window.setTimeout(request, POLL_MS);
      },
    });

    request();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  const you = poll?.you;
  const round = poll?.round;
  const submitted = Boolean(you?.submitted);
  const canSubmit = Boolean(word.trim()) && !submitted && !submitWord.isPending;
  const phase = round?.phase?.toLowerCase() || 'waiting';

  useEffect(() => {
    const roundId = round?.roundId ?? null;
    if (roundId !== previousRoundId.current) {
      setWord('');
      submitWord.reset();
      previousRoundId.current = roundId;
    }
  }, [round?.roundId, submitWord]);

  if (lastPollFailure) {
    const mayBeToken = lastPollFailure.status === 403 || /token|join code|stale|code/i.test(lastPollFailure.message);
    return (
      <Shell>
        <BrandBar joinedName={name} onEdit={onEdit} />
        <section className="mx-auto w-full max-w-2xl rounded-[28px] border border-destructive/20 bg-card p-6 shadow-md sm:p-9">
          <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-destructive">Could not update the game</p>
          <h1 className="display-face mt-3 text-3xl font-extrabold sm:text-4xl">The game server sent an error.</h1>
          <p data-testid="status-poll-error" role="alert" className="mt-4 rounded-2xl bg-destructive/5 px-4 py-3 text-base font-semibold leading-7 text-destructive">
            {lastPollFailure.message}
          </p>
          {mayBeToken ? <p className="mt-5 text-sm leading-6 text-muted-foreground">The join code may have changed — re-enter it to join again.</p> : null}
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => {
                const credentials = credentialsRef.current;
                if (credentials) pollRef.current({ data: credentials });
              }}
              className="focus-ring h-12 rounded-2xl bg-primary px-5 font-extrabold text-primary-foreground"
              data-testid="button-retry-poll"
            >
              Retry now
            </button>
            {mayBeToken ? <button type="button" onClick={onEdit} className="focus-ring h-12 rounded-2xl border border-border bg-background px-5 font-extrabold" data-testid="button-edit-join">Re-enter join code</button> : null}
          </div>
        </section>
      </Shell>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credentials = credentialsRef.current;
    if (!canSubmit || !credentials) return;
    const played = word.trim();
    submitRef.current(
      { data: { ...credentials, word: played } },
      {
        onSuccess: (result) => {
          if (!result.ok) return;
          setWord('');
          setRecentWords(
            appendHistory({
              word: result.word ?? played,
              ...(you?.hint ? { hint: you.hint } : {}),
              at: Date.now(),
            }),
          );
          pollRef.current({ data: credentials }, { onSuccess: setPoll });
        },
      },
    );
  }

  return (
    <Shell>
      <BrandBar
        joinedName={name}
        deployed={poll?.player ? Boolean(poll.player.deployed) : undefined}
        onEdit={onEdit}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-5">
          <section className="overflow-hidden rounded-[28px] border border-card-border bg-card shadow-md">
            <div className="flex flex-wrap items-start justify-between gap-5 border-b border-border px-5 py-5 sm:px-7">
              <div>
                <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-primary">
                  <span className="h-2 w-2 rounded-full bg-primary" />
                  Round {round?.seq ?? '—'} · {phase}
                </div>
                <h1 data-testid="text-round-title" className="display-face mt-2 text-3xl font-extrabold sm:text-4xl">{round?.title || 'Waiting for the next story'}</h1>
              </div>
              <div className="min-w-[86px] rounded-2xl bg-muted px-3 py-2 text-right">
                <p className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Time left</p>
                <Countdown endsAt={round?.endsAt} now={clock} />
              </div>
            </div>
            <div className="px-5 py-7 sm:px-7 sm:py-9">
              <div data-testid="round-status" className="rounded-2xl bg-muted px-5 py-8 text-center text-base font-semibold text-muted-foreground">
                {!round
                  ? 'Waiting for the host to start a round.'
                  : phase === 'collecting'
                    ? 'Submissions are open. The story stays hidden until the round closes.'
                    : phase === 'results'
                      ? 'Submissions are closed. Here is how it turned out.'
                      : 'Waiting for the next round.'}
              </div>
            </div>
          </section>

          {phase === 'collecting' && you?.blankIndex !== null && you?.blankIndex !== undefined ? (
          <section className="rounded-[28px] border border-card-border bg-card p-5 shadow-sm sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-orange-600">Your blank · number {you.blankIndex + 1}</p>
                <h2 className="display-face mt-2 text-[27px] font-extrabold">{you.hint || 'Choose a word for the blank'}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{you.example ? `For example: ${you.example}` : 'Keep it short, specific, and a little unexpected.'}</p>
              </div>
            </div>
            {submitted ? (
              <div data-testid="status-submitted" className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-emerald-800">
                <p className="text-lg font-extrabold">✓ submitted</p>
                <p className="mt-1 text-base font-bold">{you.word}</p>
                <p className="mt-2 text-sm">One word per person per round.</p>
              </div>
            ) : (
              <form onSubmit={submit} className="mt-6 flex flex-col gap-3 sm:flex-row">
                <input
                  value={word}
                  onChange={(event) => setWord(event.target.value)}
                  disabled={submitWord.isPending}
                  maxLength={40}
                  placeholder="Type your word"
                  data-testid="input-assigned-word"
                  className="focus-ring h-14 min-w-0 flex-1 rounded-2xl border border-input bg-background px-4 text-lg font-bold outline-none placeholder:font-medium placeholder:text-muted-foreground/60"
                />
                <button type="submit" disabled={!canSubmit} data-testid="button-submit-word" className="focus-ring h-14 rounded-2xl bg-primary px-6 font-extrabold text-primary-foreground shadow-sm disabled:cursor-not-allowed disabled:opacity-50">
                  {submitWord.isPending ? 'Sending…' : 'Submit word'}
                </button>
              </form>
            )}
            {submitWord.isError ? <p role="alert" data-testid="status-submit-error" className="mt-3 text-sm font-semibold text-destructive">{apiError(submitWord.error, 'That word could not be submitted. Try again.')}</p> : null}
          </section>
          ) : null}

          {phase === 'collecting' && (you?.blankIndex === null || you?.blankIndex === undefined) ? (
            <section data-testid="status-no-blank" className="rounded-[28px] border border-card-border bg-card p-5 text-base leading-7 text-muted-foreground shadow-sm sm:p-7">
              No blank assigned this round — you joined after the assignments went out. You are in
              the next one.
            </section>
          ) : null}

          {round && phase === 'results' ? (
            <section className="rounded-[28px] border border-card-border bg-card p-5 shadow-md sm:p-7">
              <Story parts={round.parts} />
            </section>
          ) : null}
        </div>

        <aside className="space-y-5">
          <StatStrip stats={poll?.stats} />
          <section className="rounded-[24px] border border-card-border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-extrabold">Your recent words</h2>
              <span className="mono-face text-xs text-muted-foreground">{recentWords.length}</span>
            </div>
            {recentWords.length ? (
              <ul className="mt-3 divide-y divide-border">
                {recentWords.slice(-6).reverse().map((recent, index) => (
                  <li key={`${recent.word}-${recent.at}-${index}`} data-testid={`text-recent-word-${index}`} className="py-2.5">
                    {recent.hint ? (
                      <p className="text-[10px] font-extrabold uppercase tracking-[0.11em] text-muted-foreground">{recent.hint}</p>
                    ) : null}
                    <p className="mt-0.5 text-sm font-bold text-foreground">{recent.word}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="empty-recent-words" className="mt-4 rounded-xl bg-muted px-3 py-4 text-sm leading-5 text-muted-foreground">Nothing submitted yet. Your first word goes here.</p>
            )}
          </section>
        </aside>
      </div>
    </Shell>
  );
}

function Home() {
  const [joinedName, setJoinedName] = useState<string | null>(null);
  function returnToJoin() {
    setJoinedName(null);
  }

  return joinedName ? (
    <GameScreen
      name={joinedName}
      onEdit={returnToJoin}
      onSessionEnded={returnToJoin}
    />
  ) : (
    <JoinScreen onJoined={({ name }) => setJoinedName(name)} />
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <Home />
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;