# How to submit Kairune to the Virtuals Showcase

The Showcase is **not a web form** — it is a Pull Request against
`Virtual-Protocol/acp-cli-demos`. After maintainers merge it, a sync workflow
opens a generated data PR and the card appears on
`https://os.virtuals.io/community#showcase`.

This folder contains everything ready to copy into that PR.

## Files here
- `showcase.json` — the manifest (drop it at `showcase/kairune-verifiable-trust/showcase.json`)
- `PR.md` — paste as the PR description
- `assets/` — put the poster + demo video here before committing (see below)

## Steps

1. **Fork** `https://github.com/Virtual-Protocol/acp-cli-demos` (branch from latest `main`).

2. **Create the package folder** in your fork:
   ```
   showcase/kairune-verifiable-trust/
     showcase.json
     assets/
       kairune-verify-demo.mp4
       poster.png
   ```

3. **Copy the assets** (they live in this repo under `brand/`, which is git-ignored):
   ```bash
   cp brand/kairune-verify-demo.mp4            <fork>/showcase/kairune-verifiable-trust/assets/
   cp brand/kairune-verifiable-attestations.png <fork>/showcase/kairune-verifiable-trust/assets/poster.png
   ```

4. **Copy `showcase.json`** into the package folder. The `videoUrl` and
   `posterUrl` already point at the `raw.githubusercontent.com` paths those
   files will have once committed to `acp-cli-demos/main` — no edit needed if
   you keep the same slug and file names.

5. **Fill the placeholders** in `showcase.json`:
   - `links.video` / `links.share` — set to your X demo post URL, **or delete
     both lines**. If you keep `links.video`, `visual.videoLabel` must name the
     platform (e.g. `Watch the 0:06 demo on X`). Inline playback works from
     `visual.videoUrl` alone, so you can safely omit `links.video`.
   - `links.feedback` — set to a prefilled feedback issue URL, or delete the line.

6. **Verify before opening the PR:**
   - `primitives` values are accepted by the validator (I used `["acp","token"]`
     — confirm against the repo's allowed list; adjust to e.g. `wallet`/`card`
     if required).
   - `visual.videoUrl` is a direct `.mp4` (H.264) `raw.githubusercontent.com`
     URL — page/blob/share URLs are rejected.
   - `visual.posterUrl` is an `https://` image URL.

7. **Open the PR** against `Virtual-Protocol/acp-cli-demos` and paste `PR.md` as
   the body. Compare page: https://github.com/Virtual-Protocol/acp-cli-demos/compare

## Optional but recommended
- **Post the demo on X** first (from `@usekairune`) using
  `brand/verify-demo-tweet.md`, then use that post URL for `links.video`
  (`videoLabel: "Watch the 0:06 demo on X"`). An X video is the most shareable
  proof format.
- Consider adding a reusable **SKILL.md** later (e.g. "verify an agent's trust
  score before granting spend") to strengthen the submission — template:
  https://github.com/Virtual-Protocol/whitepaper-economyOS/blob/main/docs/showcase-skill-template.md
