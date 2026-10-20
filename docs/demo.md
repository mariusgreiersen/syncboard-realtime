# Demo script and recording guide

## Start

```bash
cp .env.example .env
docker compose up --build        # http://localhost:8080
```

Use two **separate** browser sessions — two different browsers, or one normal and one private window
(two tabs of the same window share the cookie and would be the same user).

## Two-browser walkthrough (≈ 90 seconds)

| # | Browser A — Alice | Browser B — Bob |
|---|---|---|
| 1 | *Continue as Alice* → **Product Launch Workspace** | *Continue as Bob* → same board |
| 2 | Both avatars appear; header says "2 people viewing" | same |
| 3 | **To Do → Add task** "Implement authentication v2" | card appears without refreshing |
| 4 | card moves | drag it to **In Progress** |
| 5 | open the card | |
| 6 | priority/description update live in the open drawer | open the card, set **Urgent**, add a description, **Save** |
| 7 | **Settings → Developer → Collaboration diagnostics**, back to the board, press **Disconnect** → "Offline" banner, adding tasks disabled | |
| 8 | (sees nothing) | create a task, move another one |
| 9 | press **Reconnect** → "Synchronizing…" → "Live", Bob's changes appear | |
| 10 | both boards show the same columns and order | |

### Conflict demo (≈ 30 seconds)

1. Both open **Write API documentation**.
2. Bob types a new title but does **not** save.
3. Alice changes the title and saves.
4. Bob immediately sees *"A collaborator updated this task while you were editing."*
5. Bob clicks **Save** → *"This task was modified by another collaborator."* with a theirs/yours table,
   and the toast *"This task was changed by another collaborator. The board has been refreshed."*
6. Bob chooses **Apply my changes on top** (or **Use their version**).

### Showing a real outage

`docker compose stop server` makes every browser show **Reconnecting…** (board still visible, editing
paused). `docker compose start server` → clients reconnect automatically and resynchronise.

### Reset the demo data

```bash
docker compose exec server node dist/seed.js --reset
```

## Recording tips

- Arrange both windows side by side at ~960 px wide each (Windows: `Win + ←` / `Win + →`;
  macOS: drag to a split view). Use 100 % zoom and light theme in one window, dark in the other, to
  make it obvious they are different sessions.
- Turn on the diagnostics panel in one window: viewers can watch the board revision increase and the
  pending-mutation count go to zero.
- Record with OBS Studio (Display Capture, 1920 × 1080, 30 fps) or the Windows Game Bar (`Win + Alt + R`)
  / macOS `Cmd + Shift + 5`. Keep it to 60–90 seconds and narrate one sentence per step.
- Everything in the video should come from the real app — no edited or mocked updates.
