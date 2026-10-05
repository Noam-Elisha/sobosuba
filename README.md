# sobosuba (fan remake)

A browser remake of keepeetron's squishy merge game *sobosuba*, in plain HTML, CSS and JavaScript. It has no build step and no dependencies.

## Run it

Double-click `index.html`. To serve it instead:

```
python -m http.server 8737
```

Then open http://localhost:8737. Add `?debug` to the URL to show an FPS and bead counter.

## How to play

- Grab any blob in the top row and drag to aim. A longer arrow means a harder shot.
- Tap a blob without dragging to drop it gently.
- When two blobs with the same number touch, they fuse into the next number (1 → 2 → 4 → …).
- If the pile stays above the red line for 3 seconds, the game is over.
- Keyboard: ← → pick a blob · hold Space to charge (← → while charging changes the angle) · Esc opens the menu · M mutes.

## Files

- `js/physics.js`: the soft-body solver. Each blob is a "water balloon": a ring of beads with a floppy skin and incompressible volume. Beads push against the other blob's skin segments rather than its beads, so surfaces slide smoothly. Contacts are nearly frictionless and inelastic, so blobs splat and slosh instead of bouncing. It uses position-based dynamics (XPBD for the skin) with 3 substeps per 120 Hz update, run at half speed (`TIME_SCALE`), and a spatial-hash grid for collisions. The feel constants are at the top of the file.
- Proportions, colors, speeds and wobble were matched against frame-by-frame measurements of real gameplay footage: board shape, blob area growing as value^0.385, shot speed, and how slowly blobs jiggle and slosh.
- `js/game.js`: game rules, input, rendering, achievements and menus.
- `js/audio.js`: sound effects synthesized with WebAudio, so there are no sound files.
