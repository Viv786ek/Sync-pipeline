import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import syncRouter from "./sync.js";
import recordsRouter from "./records.js";
import authRouter from "./auth.js";
import webhookRouter from "./webhook.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(syncRouter);
router.use(recordsRouter);
router.use(authRouter);
router.use(webhookRouter);

export default router;
