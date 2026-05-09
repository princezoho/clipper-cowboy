import { Router } from "express";
import { z } from "zod";
import {
  clearState,
  loadState,
  setSkipped,
  startAnalysis,
} from "../util/autocut.js";
import { resolvePoolId } from "./pool.js";

const router = Router();

router.get("/auto-cut/:sourceId", (req, res) => {
  const file = resolvePoolId(req.params.sourceId);
  if (!file) {
    res.status(404).json({ error: "source not found" });
    return;
  }
  const state = loadState(req.params.sourceId);
  res.json(state);
});

router.post("/auto-cut/:sourceId", (req, res) => {
  const file = resolvePoolId(req.params.sourceId);
  if (!file) {
    res.status(404).json({ error: "source not found" });
    return;
  }
  const state = startAnalysis(req.params.sourceId, file);
  res.json(state);
});

router.delete("/auto-cut/:sourceId", (req, res) => {
  clearState(req.params.sourceId);
  res.json({ ok: true });
});

router.post("/auto-cut/:sourceId/skip", (req, res) => {
  const Schema = z.object({
    candidateId: z.string(),
    skipped: z.boolean().default(true),
  });
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const state = setSkipped(
    req.params.sourceId,
    parsed.data.candidateId,
    parsed.data.skipped
  );
  res.json(state);
});

export default router;
