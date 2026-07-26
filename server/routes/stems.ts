import { Router } from "express";
import { universalStemManager } from "../stems/universalManager.js";

const router = Router();

router.get("/audio-engine/status", async (_req, res) => {
  const status = await universalStemManager.inspectConnector();
  res.json({
    ready: status.ready,
    installing: false,
    pythonAvailable: status.connected,
    ...(status.ready ? { recommendedQuality: "high" as const } : {}),
    installedQualities: status.ready ? (["high"] as const) : [],
    message: status.message,
  });
});
router.get("/audio-engine/install", (_req, res) => {
  res.json({
    status: "error",
    message:
      "Clipper never installs Stem Studio or models. Finish setup in Stem Studio, then retry Universal Clipper.",
    updatedAt: Date.now(),
  });
});
router.post("/audio-engine/install", (_req, res) => {
  res.status(409).json({
    error:
      "Automatic setup is disabled. Use the official Stem Studio app/MCP setup, then retry Universal Clipper.",
  });
});

router.get("/stem-jobs", (_req, res) => res.json({ items: [] }));
router.get("/stem-jobs/:id", (_req, res) =>
  res.status(410).json({
    error:
      "Legacy clip-level stems were retired. Use Universal Clipper package stems.",
  })
);
router.post("/stem-jobs/:id/cancel", (_req, res) =>
  res.status(410).json({
    error:
      "Legacy clip-level stems were retired. Cancel the Universal Clipper stem job instead.",
  })
);
router.post("/stem-jobs/:id/reveal", (_req, res) =>
  res.status(410).json({
    error:
      "Legacy clip-level stems were retired. Reveal the Universal Clipper package instead.",
  })
);
router.post("/stem-jobs/reveal-root", (_req, res) =>
  res.status(410).json({
    error:
      "Use Reveal package in Universal Clipper after validated publication.",
  })
);
router.post("/library/:id/stems", (_req, res) =>
  res.status(410).json({
    error:
      "Select Library clips and use Universal Clipper. It runs only the official Stem Studio MCP.",
  })
);

export default router;
