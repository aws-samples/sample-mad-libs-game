import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetConfigResponse,
  GetMyWordsResponse,
  JoinGameBody,
  JoinGameResponse,
  PollGameResponse,
  SubmitWordBody,
  SubmitWordResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const SESSION_COOKIE = "madlibs_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const UPSTREAM_TIMEOUT_MS = 6000;
const PLACEHOLDER = "<PASTE_GAME_SERVER_URL_HERE>";

const runningDeployed = !!(
  process.env.REPLIT_DEPLOYMENT ?? process.env.AWS_LAMBDA_FUNCTION_NAME
);
const deployedRegion =
  process.env.AWS_REGION ?? (process.env.REPLIT_DEPLOYMENT ? "replit" : "");

type Session = {
  token: string;
  gameServerUrl: string;
  playerKey: string;
  displayName: string;
  origin: string;
  createdAt: number;
};

type UpstreamError = {
  ok?: false;
  error?: string;
};

type UpstreamPlayer = {
  playerId: string;
  displayName: string;
  mode: string;
  deployed: boolean;
};

type UpstreamRoundPart = {
  kind: "text" | "blank";
  text?: string | null;
  index?: number | null;
  hint?: string | null;
  example?: string | null;
  word?: string | null;
  by?: string | null;
  filler?: boolean | null;
};

type UpstreamRound = {
  roundId: string;
  seq: number;
  phase: "lobby" | "collecting" | "results";
  title: string;
  endsAt: number | null;
  blankCount: number;
  parts: UpstreamRoundPart[];
};

type UpstreamHello = {
  ok: boolean;
  now?: number;
  player?: UpstreamPlayer;
  round?: UpstreamRound | null;
  you?: {
    blankIndex: number | null;
    hint: string | null;
    example: string | null;
    word: string | null;
    submitted: boolean;
  };
  stats?: {
    players: number;
    active: number;
    deployed: number;
    local: number;
  };
  error?: string;
};

type PlayedWord = { word: string; hint?: string; at: number };

const sessions = new Map<string, Session>();
const wordsByPlayer = new Map<string, PlayedWord[]>();

function configuredGameServerUrl(): string {
  const raw = process.env.GAME_SERVER_URL?.trim() ?? "";
  if (!raw || raw === PLACEHOLDER) return "";
  return normalizeGameServerUrl(raw) ?? "";
}

function normalizeGameServerUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function requestOrigin(req: Request): string {
  const forwardedHost = req.get("x-forwarded-host") ?? req.get("host");
  const forwardedProto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${forwardedProto}://${forwardedHost}`;
}

function sessionFor(req: Request): Session | null {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function sendError(res: Response, status: number, error: string) {
  return res.status(status).json({ ok: false, error });
}

async function readJson<T>(response: globalThis.Response): Promise<T> {
  return (await response.json()) as T;
}

async function upstreamFetch(
  url: string,
  init: RequestInit = {},
): Promise<{ response: globalThis.Response | null; data: unknown | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } catch {
    return { response: null, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

function upstreamErrorText(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const error = (data as UpstreamError).error;
  return typeof error === "string" && error ? error : null;
}

function helloPayload(session: Session) {
  return {
    token: session.token,
    playerKey: session.playerKey,
    displayName: session.displayName,
    origin: session.origin,
    mode: runningDeployed ? "aws" : "local",
    region: deployedRegion,
  };
}

function upstreamStatus(response: globalThis.Response | null): number {
  if (!response) return 502;
  if (response.status === 401) return 502;
  if (response.status >= 400 && response.status < 500) return response.status;
  return 502;
}

router.get("/config", (_req, res) => {
  const gameServerUrl = configuredGameServerUrl();
  res.json(
    GetConfigResponse.parse({
      gameServerUrl,
      fromEnv: Boolean(gameServerUrl),
    }),
  );
});

router.post("/join", async (req, res) => {
  const parsed = JoinGameBody.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Enter a join code, your name, and a game server URL.");
  }

  const normalizedUrl = normalizeGameServerUrl(parsed.data.gameServerUrl);
  if (!normalizedUrl) {
    return sendError(res, 400, "Enter a valid http or https game server URL.");
  }

  const health = await upstreamFetch(`${normalizedUrl}/game/health`);
  if (!health.response) {
    return sendError(
      res,
      502,
      `Cannot reach the game server at ${normalizedUrl}`,
    );
  }
  if (
    !health.response.ok ||
    typeof health.data !== "object" ||
    health.data === null ||
    (health.data as { ok?: boolean }).ok !== true
  ) {
    return sendError(res, 400, "That doesn't look like a madlibs game server.");
  }

  const session: Session = {
    token: parsed.data.token,
    gameServerUrl: normalizedUrl,
    playerKey: parsed.data.playerKey,
    displayName: parsed.data.displayName,
    origin: requestOrigin(req),
    createdAt: Date.now(),
  };
  const hello = await upstreamFetch(`${normalizedUrl}/game/hello`, {
    method: "POST",
    body: JSON.stringify(helloPayload(session)),
  });
  const helloError = upstreamErrorText(hello.data);
  if (!hello.response) {
    return sendError(
      res,
      502,
      `Cannot reach the game server at ${normalizedUrl}`,
    );
  }
  if (!hello.response.ok || helloError) {
    return sendError(res, upstreamStatus(hello.response), helloError ?? "The game server rejected the join.");
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, session);
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
  });
  return res.json(
    JoinGameResponse.parse({
      ok: true,
      player: (hello.data as UpstreamHello).player,
    }),
  );
});

router.post("/poll", async (req, res) => {
  const session = sessionFor(req);
  if (!session) return sendError(res, 401, "Your session has ended. Please join again.");

  const hello = await upstreamFetch(`${session.gameServerUrl}/game/hello`, {
    method: "POST",
    body: JSON.stringify(helloPayload(session)),
  });
  const helloError = upstreamErrorText(hello.data);
  if (!hello.response) {
    return sendError(
      res,
      502,
      `Cannot reach the game server at ${session.gameServerUrl}`,
    );
  }
  if (!hello.response.ok || helloError) {
    return sendError(res, upstreamStatus(hello.response), helloError ?? "The game server rejected the request.");
  }
  return res.json(PollGameResponse.parse(hello.data));
});

router.post("/submit", async (req, res) => {
  const session = sessionFor(req);
  if (!session) return sendError(res, 401, "Your session has ended. Please join again.");

  const parsed = SubmitWordBody.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Enter one word up to 40 characters.");

  const submission = await upstreamFetch(`${session.gameServerUrl}/game/submit`, {
    method: "POST",
    body: JSON.stringify({
      token: session.token,
      playerKey: session.playerKey,
      word: parsed.data.word,
    }),
  });
  const submissionError = upstreamErrorText(submission.data);
  if (!submission.response) {
    return sendError(
      res,
      502,
      `Cannot reach the game server at ${session.gameServerUrl}`,
    );
  }
  if (!submission.response.ok || submissionError) {
    return sendError(
      res,
      upstreamStatus(submission.response),
      submissionError ?? "The game server rejected the submission.",
    );
  }

  const data = submission.data as { ok: boolean; word?: string; blankIndex?: number };
  const words = wordsByPlayer.get(session.playerKey) ?? [];
  words.push({
    word: data.word ?? parsed.data.word,
    ...(parsed.data.hint ? { hint: parsed.data.hint } : {}),
    at: Date.now(),
  });
  wordsByPlayer.set(session.playerKey, words.slice(-50));
  return res.json(SubmitWordResponse.parse(data));
});

router.get("/my-words", (req, res) => {
  const session = sessionFor(req);
  if (!session) return sendError(res, 401, "Your session has ended. Please join again.");
  return res.json(
    GetMyWordsResponse.parse({
      ok: true,
      words: wordsByPlayer.get(session.playerKey) ?? [],
    }),
  );
});

export default router;