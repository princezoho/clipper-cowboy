import { Router } from "express";
import { readActivityTail } from "../util/activity.js";
import { publicError } from "../util/publicError.js";

const router = Router();

router.get("/activity", async (req, res) => {
  const raw = req.query.limit;
  const parsed = typeof raw === "string" ? Number(raw) : 10;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 10;
  try {
    const events = await readActivityTail(limit);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: publicError(err, "activity:list") });
  }
});

export default router;
