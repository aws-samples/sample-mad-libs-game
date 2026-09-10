import { Router, type IRouter } from "express";
import healthRouter from "./health";
import madlibsRouter from "./madlibs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(madlibsRouter);

export default router;
