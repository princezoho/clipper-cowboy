import { Router } from "express";
import { z } from "zod";
import {
  EntityKind,
  createEntity,
  deleteEntity,
  getEntity,
  listEntities,
  updateEntity,
} from "../util/entities.js";
import { appendActivity, ActivityKind } from "../util/activity.js";

/**
 * Build a CRUD router for one entity catalog (Scenes or Objects). Mirrors the
 * Characters route shape so the frontend can reuse the same patterns.
 */
function makeEntityRouter(kind: EntityKind): Router {
  const router = Router();

  router.get(`/${kind}`, (_req, res) => {
    res.json({ items: listEntities(kind) });
  });

  router.post(`/${kind}`, (req, res) => {
    const Schema = z.object({
      name: z.string().min(1),
      description: z.string().optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const e = createEntity(kind, parsed.data);
      const created: ActivityKind =
        kind === "scenes" ? "scene_created" : "object_created";
      appendActivity(created, { id: e.id, name: e.name });
      res.json(e);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.patch(`/${kind}/:id`, (req, res) => {
    const Schema = z.object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const e = updateEntity(kind, req.params.id, parsed.data);
    if (!e) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(e);
  });

  router.delete(`/${kind}/:id`, (req, res) => {
    const existing = getEntity(kind, req.params.id);
    const ok = deleteEntity(kind, req.params.id);
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const deleted: ActivityKind =
      kind === "scenes" ? "scene_deleted" : "object_deleted";
    appendActivity(deleted, {
      id: req.params.id,
      name: existing?.name ?? "",
    });
    res.json({ ok: true });
  });

  return router;
}

export const scenesRouter = makeEntityRouter("scenes");
export const objectsRouter = makeEntityRouter("objects");
