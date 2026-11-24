# Camera Runbook — watching the fleet through its cameras

> Operative procedure, not a law and not archival documentation. It answers one question:
> *"cold-start, how do I watch a live run through the camera windows?"* Read it when the task is the
> cameras; read
> `fleet_runbook.md` when the task is to start / test / inspect the fleet. Two questions, two files —
> the same split CLAUDE.md draws to `fleet_runbook.md`, applied one scope further out, and for the
> same reason: a terminal-only session should never carry the camera stack's weight.
>
> **Status does not live here** (a runbook holds procedure; the records hold state). What is currently verified, what is unproven, and what is half-built lives in
> `Documentation/records/architect_worklog.md`, appended at the bottom. **A
> cold-start session should find the latest camera-related entries and their unresolved limitations**, then use this
> file to drive the machinery.

---

## 1. What the camera system is (three parts, one job)

The cameras are separate from the fleet and never touch it (Law 19 — the film crew observes, it does not
act in the shared world). **Nothing here records** (2026-09-14): the crew is for watching, and each window
keeps a stable title so any screen recorder you choose can capture it. Three parts:

- **Camera clients** — one Prism Launcher Minecraft instance per bot (`Cam_AurenBot`, `Cam_TessaBot`,
  `Cam_IrisBot`), joining the local server in spectator mode under made-up offline names. Built and
  launched by `scripts/start_cameras.ps1`.
- **The director** (`camera/camera_rig.js`) — flips each camera to spectator + night vision and moves
  it shot to shot. Its knobs are all in `camera/camera_configure.js`; the rig hardcodes no number.
  It is also **the only thing that knows the crew is really in the world**: it arms a client only after
  `data get entity <cam> Pos` came back with a position, which the server answers for a joined client and
  nothing else. When every expected client — the bot cameras, plus the Architect's eye on a run that asked
  for it — has cleared that, the
  rig writes `js_kernel/camera_rig_ready.json`, and that file is what the overlay waits on before the
  fleet is told to start. The launcher cannot answer this: it returns when the process *starts*, tens of
  seconds before the world finishes loading.
- **The window titler** (`scripts/camera_window_titler.ps1`) — a background daemon that renames each
  camera's OS window to its cam name. Every Minecraft window otherwise carries the identical title, class
  and exe, so nothing outside the game can tell the cameras apart. With unique stable titles, a recorder
  such as OBS can lock a Window Capture to `Cam_<Bot>` (method "Windows 10 (1903+)", priority "Match
  title") and re-bind correctly after a restart.

### The two modes — and both start OFF

`camera/camera_configure.js` opens with a `mode` block. Nothing above runs until you set one:

```js
mode: {
  framing: false,   // the film crew: cameras, gimbals, cuts
  witness: false,   // the combat record: what the SERVER saw the fleet's fights do
},
```

They are independent. `framing` alone is the camera system as it always was. `witness` alone joins one
headless client to the server and writes a combat record with no camera anywhere — useful when you want
the data and not the footage. Both on is the same client doing both jobs. Both off and the rig announces
which key to flip and exits rather than idling on a game slot.

**The witness in one line:** the bot's own watcher trace is the defendant's story; this is a bystander's,
written blind to it, and the two are put side by side by `node monitoring/trace_monitor.js --witness`.
It samples only while a fight is actually open, so an idle fleet writes nothing. Its file is
`fleet_logs/combat_witness/combat_witness.jsonl`, overwritten each start — **never open it directly, read
it through the lens.**

---

## 2. One-time setup on a machine that has never run the cameras

Idempotent; re-running it is safe and is the repair path.

1. **Prism + the camera instances** (uses an installed Prism, or downloads the portable build — about
   1 GB with game files — into `Auren_Workshop/camera/clients/PrismLauncher`, inside the bot and
   gitignored; builds one plain-vanilla instance per bot and copies your main game's **resource** packs in):
   ```
   .\Auren_Workshop\scripts\start_cameras.ps1 -SetupOnly
   ```
   The **one** genuinely manual step in the entire system is inside this: Prism opens so you can add
   your Microsoft account once (Accounts → Manage Accounts → Add Microsoft). That single login proves
   ownership; the cameras then join the offline-mode local server under invented names forever after.
   No extra accounts, no extra purchases. Re-run the command after logging in.

   **No shaders, and no mod loader — this is settled, not a default to flip back.** A resource pack
   costs VRAM once at load; a shader pack costs GPU time on every frame and spikes hard whenever
   chunks build, and the fleet scales to 3–5 bots each with a camera, so that per-frame cost is
   multiplied by the number of windows. Textures survive the scaling, shaders do not. The instances
   are therefore bare vanilla: no Fabric, no Iris, no Sodium, nothing downloaded from Modrinth. An
   instance built by an older revision is **migrated** on the next run — the pack is rewritten to the
   single vanilla component and `mods/`, `shaderpacks/` and `config/iris.properties` are deleted, so
   the disk states one truth about what a camera runs.

---

## 3. Cold start: watching a live run

**The automated route is a FIELD on the config page — `fleet_runbook.md` §3, and it is what to reach
for.** A run with `record: 'cameras'` on `foreman_config.js` has the foreman raise the camera crew as a startup
step, before the world spawn and the crew — `node start_auren.js` performs it, and
`node Auren_Workshop/fleet_control.js down` closes the cameras and the world together
(`record_overlay.js stop` owns the camera half and `down` delegates to it). It turns framing on for its
own run, so `mode.framing` below can stay off. The **Architect's eye** — the seat a human flies — is NOT
raised unless `camera_configure` says so (§8).

`record: 'film'` is the same run with a recorder writing every window to a file. A download has no
recorder, so it refuses `film` before anything starts and names `cameras` instead.

By hand, the cameras need a server to join, so the world comes first:

```
.\Auren_Workshop\scripts\start_cameras.ps1 -Framing          # the crew + director + titler
.\Auren_Workshop\scripts\start_cameras.ps1 -Down             # reap what it raised
```

**Nametags are off, and nothing needs pressing.** `camera_rig` puts every player into a scoreboard team
with `nametagVisibility never` at bring-up. A nametag is drawn *into the frame* by the client rather
than onto the HUD, so it is part of the picture — a team is the only server-side switch
for it, and the rig is the only thing in the stack holding an RCON connection. It covers the **bots**
(the names actually in shot) and the spectators alike, because a camera filming a bot can otherwise
catch another camera's name floating behind it. The team persists in the world's scoreboard and is
re-asserted every run rather than torn down.

**What that costs, and what replaces it.** Nametags render *through* terrain, so they used to be how
you found a bot behind a tree from the Architect's eye. That affordance is now `/tp <bot>` from the eye
itself, which keeps its chat and its operator rights for exactly this reason (§8).

**Do not press F1.** It buys almost nothing now: the cameras are spectators, so hotbar / hearts /
hunger / XP are already gone; chat is suppressed by `chatVisibility:2` on the **directed** cameras; and
the nametags are handled above. The Architect's eye deliberately keeps its chat (§8) — it is a seat,
not a shot. F1 also cannot be automated, so keeping it in the loop would break the unattended chain.

**Never minimize a camera window.** Occluded is fine — `start_cameras.ps1` keeps an unfocused window
rendering (`pauseOnLostFocus:false`, `inactivityFpsLimit:minimized`), so the cameras can be **stacked on
one monitor**. *Minimized* is not fine: a minimized window stops producing frames.

---

## 5. Diagnosis — the traps, and what each looks like

The director's diagnostics route to `fleet_logs/traces/watcher_camera_rig.jsonl`, readable with `trace.ps1`
like any other unit.

### 5a. The camera's own trace (`trace_monitor --camera`)

```
node Auren_Bot/monitoring/trace_monitor.js --camera [--bot=AurenBot] [--all]
```

**The camera writes a PARALLEL watcher trace and it is not part of the fleet view** (Architect
2026-08-22: *"everything the scout camera does needs to go on a parallel watcher trace besides the fleet
one for the bots"*). Both records live in `fleet_logs/traces/` under the same filename rule; `trace_read` keeps
the two views apart, because the director re-solves a vantage about once a second and a merged view
buries four bots' story in camera work. `--camera` is the camera view's one reader.

It answers the three questions the footage raises, in that order:

| section | the question it answers |
|---|---|
| the eyes | did the scout connect, where did it PARK to scan, and did the chunks ever stream — a park that timed out means the seeks that followed it were blind, so every figure below is about a world the seeker could not see. Also the deaf window: a raycast makes the client unable to hear the server while it runs |
| moved | every cut by CAUSE — `frame_exit`, `max_hold`, `sightline_lost`, `frame_spoiled`, `better_vantage`, `arrival`, `announcement`, `too_far`, `startup` — with the median shot length beside it |
| held | the decisions that did NOT move the camera: `no_better` (it looked and the standing shot won), `absorbed` (the event was already in frame), `min_hold`, `no_op`. Posted on a CHANGE of reason, never once per seek |
| SUBJECT | could the lens see the bot at all, per siting. Printed above the verdict on purpose: it is the question a reader arrives with, and it is not what the verdict answers |
| sited | where the search LANDED: `clear` (a direction passed the air box and the lens box) / `forced` (none did, the furthest-reaching was taken anyway) / `first_person` / `see_through` / `blind` |
| boxes | air-box and lens-box rejections before a direction was taken — the seeker's only quality bar, so this is the figure that says whether it is set right for the terrain |
| scanned | the cost and the reach: field casts, rays, milliseconds, how many directions came back open and how many were roomy enough to stand a camera in |
| `--all` | every cut in order, from → to, with its held time and the bot's job |

**Reading the canopy complaint with it.** A run whose footage is leaves shows one of three shapes, and
they have different fixes: `SUBJECT` low means the bot itself was behind blocks — the terrain is the
problem; `sited: forced` dominant while the `boxes` counts climb means the air box and the lens box are
too strict for that terrain and the seeker is being starved by its own guards; and `30° RELAXED` on most
sitings means consecutive shots are near-identical because no bearing differed enough. A run of
`first_person` verdicts is not a fault at all — it is a bot in a one-block corridor, or the thrash guard
holding the camera off a shot that keeps dying on arrival.

**Both registers are written for every decision, deliberately.** The prose line is for a person scrolling
the trace; the `crew_log` event beside it is for this lens. That is two renderings of one fact, which is
normally the redundancy Law 16 forbids — it is legal here for the reason Law 26 gives: one of the two
readers is a machine, and the alternative is a lens parsing English.

---

## 6. Recording and editing are not in this download

**Watching ends here.** Everything above ships with the bot: it raises the clients, directs them and
titles their windows. Writing those windows to files, and cutting the files into a video, are done by
other tools with other owners (2026-09-14: the recording moved out of the bot with the editor, which
moved on 2026-09-11). If you want footage, point your own recorder at the `Cam_<Bot>` windows while a
`record: 'cameras'` run is up. The dependency runs one way — those tools read the bot, the bot never
reads them — and `preflight`'s layer-separation pass holds that line for this document too.

## 7. Adding a bot

Nothing here needs editing. Add the bot to `BOT_SENIORITY` in `Thinking_fragments/architect_config.js`
— the single source (Law 16) — and its camera instance and its window title follow automatically. That is the whole point of the system:
**camera count is a parameter, not an operator cost.**

---

## 8. The Architect's eye — a camera nothing directs, raised only when asked for

**OFF BY DEFAULT. Turn it on in `camera_configure.js` — `architect.enable: true` — and every route reads
it.** The conductor's `--architect` flag was retired on 2026-08-25 with the rest of the run options: which
camera seats exist is this file's answer and always was, and a flag that overrode it was a second answer to
a one-owner question (Law 16). The routes below still take it because none of them has an authored run
behind it to read.

```
node Auren_Workshop/tools/lanista_conductor.js ladder watch --architect
# the same, as a configured run: record: 'cameras' on foreman_config.js (the Architect's eye is a camera_configure setting)
node start_auren.js --record cameras
.\Auren_Workshop\scripts\start_cameras.ps1 -Framing -Architect
```

To have it on **standing**, set `architect.enable: true` in `camera/camera_configure.js` — that is the one
declaration every consumer reads, and `--architect=off` still overrides it for a single run.

`Cam_Architect` is one more spectator client, built and launched exactly like a bot camera (same vanilla
instance and resource packs, same 1920×1080 pin, same unique window title). What makes it
the Architect's is an **absence**: it is passed to the director as `--freecams`, never as `--bots`, so it
never enters the rig's shot list and no cut, teleport or gimbal bind can reach it. The rig sends it exactly
two commands, once — `gamemode spectator` and infinite night vision — and then nothing for the rest of the
run. A human flies it.

The exclusion is expressed as two separate lists in the launcher rather than as a rule inside the rig,
because a rule inside the rig is a promise a later edit can weaken, and a name that was never passed cannot
be commanded at all.

**It is EQUIPPED, not directed — and that is the difference between this seat and every other client.**
The rig grants it three capabilities once and then issues no instruction: **spectator** (it cannot fall,
die, or block a mob), **night vision** (a night flight is usable), and **operator** (the human flying it
can act). It is also the one camera whose **chat stays visible** — every directed camera runs
`chatVisibility:2` so no system message lands in a shot, but hiding it here removed the only input channel
a human in that window has. Architect, 2026-08-16: *"i need to be able to teleport to bots i want to look
at or maybe even change a setting like daytime, i could also spawn monsters if i want... its a free thing
for me to use as i see fit."* So from inside that window:

```
/tp @s AurenBot          fly to a bot you have lost sight of
/time set day            or  /time set night
/gamemode creative       stop spectating and build, place, break
/summon zombie ~ ~ ~     put something in front of a bot and watch what it does
```

`chatVisibility` is `0` (shown) rather than `1` (commands only), because "commands only" hides the
**response** — a refused teleport would look identical to one that worked. The `op` is re-issued on every
run rather than set once by hand: it persists in the server's `ops.json`, so re-arming is idempotent and
self-healing, and a grant lost to a server reinstall repairs itself instead of failing at the moment it is
needed (Invariant B — re-assert, never trust a remembered grant).

**WHY IT DEFAULTS OFF, and why the pairing ruling that preceded it was right at the time.** From
2026-08-16 the eye was welded to every crew: *"there will never be a time where there are cameras without
my controllable one. so pair it all together permanently."* — and while a filming session was a few
minutes of watching the director work, that was true. It stopped being true when runs became soaks:
**a 45-minute run needs 45 minutes of flying**, and the Architect is not the operator of his own record.
The seat is now the only one in the crew that produces nothing unless a human is in it for the whole run;
every other camera is directed and its footage exists whether anyone is watching or not. A cost with no
product is exactly what Law 13's default-stopped names, so the switch came back — and the constraint that
justified deleting it (a switch implies a legitimate off position) is satisfied rather than overruled,
because the off position is now the ordinary one. The re-tune happened at the table, not at the pedal
(Law 21).

```
.\Auren_Workshop\scripts\start_cameras.ps1                     # N bot cameras + director + titler, NO eye
.\Auren_Workshop\scripts\start_cameras.ps1 -Architect          # …and the seat you fly
.\Auren_Workshop\scripts\start_cameras.ps1 -Framing            # director with framing ON (config default is off)
.\Auren_Workshop\scripts\start_cameras.ps1 -Down               # reap the clients + director this script raised
```

`-Down` is the half of Law 8 that was missing: this script raises the camera clients, a director and a
titler, and `fleet_control down` knows about none of them — so before it existed every filmed run left
camera windows and a director standing. Matching is by **command line** (the instance path for a client,
`camera_rig.js` for the director), the same order-independent discriminator the titler uses. The titler is
deliberately **not** killed: it exits on its own the pass after the last window goes.

Its names are declared once, in `camera_configure.js` (`architect.camNames`), and read from there by every
consumer — the launcher, the rig, the titler and the recorder (Law 16). Each saved angle is one window,
`Cam_<number>`, put at its shot when it joins and left to its pilot (§8a).

### 8a. Saving angles: one inspector seat, then one camera per angle

Fly `Cam_Inspector` on an inspection run (`fleet_runbook.md` §3a-bis) to the shot you want, then say so:

| from | save at the next number | save over a number | list | drop one |
|---|---|---|---|---|
| that seat's chat | `save` | `save 4` | `list` | `forget 4` |
| the foreman's console | `camera-save` | `camera-save 4` | `camera-list` | `camera-forget 4` |
| a terminal | `node Auren_Workshop/fleet_control.js verb camera-save` | `… verb camera-save --number=4` | `… verb camera-list` | `… verb camera-forget --number=4` |

The foreman reads the seat's position and facing off the server and answers in chat. The shots live in
`camera/clients/camera_spots.json`, gitignored and shared by every copy on this machine, and start from three
shots until the first change (`js_kernel/utils/camera_spots.js`). Saved shots take effect the next time cameras
are raised, one window for each:

```
$env:AUREN_RECORD='cameras'; $env:AUREN_CAMERAS='none'; node start_auren.js --start continue
$env:AUREN_SEATS='Cam_1,Cam_4'   # only these, for one run
```

---

## 9. THE HOST SEAT — a seat you PLAY, and a camera per bot as it stands up

The host seat and the camera warden serve any run.

### 9a. Three seats now, and they differ in one property each

| | directed camera | the Architect's eye | **the host seat** |
|---|---|---|---|
| passed to the rig as | `--bots` | `--freecams` | **`--present`** |
| what the rig does to it | places it, cuts it, binds a gimbal | spectator + night vision + op, once | **one read: "are you standing yet"** |
| gamemode | spectator | spectator | **whatever the server gave you — you PLAY** |
| chat | hidden (`chatVisibility:2`) | shown | **shown** |
| joins as | `Cam_<Bot>` | `Cam_Architect` | **your real name** (`host.playerName`) |

**The host is not the eye with a flag, and the difference is the one property that decides whether a client
may act in the world.** The eye is a spectator on purpose — it cannot fall, die, block a mob or change the
world the run is measuring. A presenter must do all four: he mines, he builds, he dies, he stands in the crew's way. So
it is a third declaration rather than a mode on the second.

**It joins under a real name**, one the server ops, so it can run `/time set day` from inside its own
window. The name is
`host.playerName` in `camera_configure.js` and it must be one the server ops
(`MinecraftServer/ops.json`). It is `KaptainKrispyjr`.

**Its settings are seeded from your real game, once, at creation.** `%APPDATA%\.minecraft\options.txt` is
copied into the instance the first time it is built — keybinds, sensitivity, FOV, GUI scale — so the seat
feels like your game rather than a bare install. **Never re-asserted afterwards**, unlike every other option
this launcher owns: those are footage settings nothing else owns, these are your preferences, and a launcher
that copied them back each run would silently undo whatever you changed last session.

### 9c. The camera warden — a camera for a bot that did not exist when the run started

`tools/camera_warden.js`, raised by the overlay on every camera run and reaped with it.

**It watches the world, not the launcher.** It asks the foreman's registry who is standing, every 6
seconds, and gives a camera to anyone who has none. That covers the foreman's own raise, a hand `bot-start`, a revive,
and anything not yet written — because none of them is what it is watching.

**The obvious wiring — a hook in the launcher — is wrong twice.** `bot-start` returns when the PROCESS is
launched; a body enters the registry only after it connects, spawns and `master_core` initialises, seconds
later. A camera raised on the launcher's return is aimed at a bot that is not in the world yet — the exact
defect the foreman's own crew loop was rebuilt to fix. And it would put the film crew inside the fleet's
pathways, so a run's behaviour would depend on whether it was being filmed, which is the one thing filming
must never do (§1).

**Per attach, in this order, every step an existing owner:**

```
start_cameras.ps1 -Bots <every standing bot> -Add    build + launch what is missing, restart director + titler
```

**`-Add` converges rather than adds.** The caller passes the whole set it wants standing; the launcher
starts only what is missing and restarts the director and titler over all of it. That makes the call its own
repair path — a client that died in between is relaunched by the same pass that adds the new one. The
director and titler are **restarted, not extended**, because both take their roster once at launch and never
re-read it: a late camera would otherwise never be armed and never be titled, and an untitled window is
one nothing outside the game can tell apart. The cost is a few seconds' gap in camera *movement*.

**It attaches only. A camera is never taken down mid-run.** A body that leaves the registry keeps
its camera, which goes on showing an empty vantage until the run ends: that costs a window and nothing else,
whereas killing a client something may be capturing cuts that capture off mid-file. The whole crew comes
down together, in order, at teardown. The registry is the right sensor for this too: it holds CONNECTION, not life, so a
bot that merely **died** keeps its camera and only one that genuinely left drops out.

**There is a ceiling, and it counts WINDOWS.** `--max-cameras`, default 6, including the host seat and the
eye — they are on the same GPU. Past it the warden names the bots it is **not** filming and keeps going,
once each, rather than silently filming some of them.

### 9d. What to check when a let's play goes wrong

| Symptom | Where to look |
|---|---|
| the run says it is up and no window opened | `record_overlay.js status` — is the warden UP? Then `Auren_Workshop\camera\clients\camera_launch_logs\Cam_Architect_Control.*.log` |
| bots came, no cameras | the warden's own window: it prints every attach and every refusal. A ceiling refusal says so by name |
| the run refuses before anything opens | `AUREN_SERVER_HOST` points off this box. Every camera joins `127.0.0.1`, so the overlay refuses rather than filming an empty world |

## 10. The watch pair — a site cam and a rider cam that go where the activity is

**Three cameras make a typical recording.** A **static cam** that never moves and films the whole area (the eye
or a saved angle, §8 and §8a), and the **watch pair**: the **site cam** (`Cam_Site`), which watches the PLACE of
the activity, and the **rider cam** (`Cam_Rider`), which rides the BOT doing it (§11). Both moving cameras clear
the canopy: the site cam is framed by `site_framing.js` over the trees, and the rider rides as high as its line
to the bot is clear. Not `scout.*` in `camera_configure.js`, which is the headless client that reads the world
for every camera and films nothing.

**What moves them.** The bodies write a fact line where a notable stretch of work begins and ends
(`[ACTIVITY] 📊 start|end`, `custom_api/activity_log.js`): a fight, a squid hunt, herding, animals through the pen
gate, a shepherd holding, shearing, culling, and **building**. The building line is written by
`building_manager` when it first dispatches a cube, before the body walks, and carries the cube's box
(`box=x,y,z,x,y,z`, from `building_integrity`'s anchor bounds); it ends when the manager hands the job back to
the judge, and the board ends it too at the body's next claim. The line changes nothing the body does.
The director tails every roster bot's story, folds those lines into open spans, and puts the pair on the open
activity that ranks highest on the focus. It moves when that activity ends, or when a higher-ranked one is open
and the pair has held this one for `siteSeat.minDwellMs` (8 s).

- **The site cam frames building only** (`siteSeat.kinds`, `['building']`, 2026-11-14). It picks for itself among
  open spans of those kinds, keeps the one it is on while it stays open, then takes the newest; with none open it
  holds its last view. A fight or a march is the rider's: framed from above in a forest it was canopy.
  Its picks are `site_pick` on the director's record.
- **The site cam** stands at a tilted overhead view of the activity's box padded by `padBlocks`
  (`elevationDeg` 50 down, `bearingDeg` 315, the box filling at most `fill` of the frame), lifted over any
  canopy by `sites.canopyPad`. An activity with no box is framed as a `defaultBox`-wide patch round its spot.
  It holds that view until the next pick.
- **The rider cam** is one rider client, `Rd_Seat`, retargeted at each pick (every ranked kind): the director
  carries it to the new bot by console and re-binds the camera, then it rides that bot until the next pick.

**The focus is set before the run, on the Cutting Room's scout page** (`/scout`, linked from the shelf): the
activities in rank order, a tick for each one the pair may film, and whether the next filmed run raises the pair
at all. It is written to `camera/clients/scout_focus.json` (machine-local, shared by every copy through the
clients junction) and read by `camera/scout_focus.js`. The director re-reads it at every pick, so a change made
during a run applies at the next pick. The bodies never read it: they state what they do, and only the camera ranks.

**Raising it.** A foreman run with `record` on raises the pair when the focus says so; `--pair=on|off` on
`record_overlay.js raise` overrides that for one run (`start_auren.js` takes no `--pair`). The overlay hands the one answer to
`start_cameras.ps1 -Pair` (both windows, and `--sitecam=Cam_Site --ridercam=Cam_Rider` to the director), to
`camera_obs` (`--pair=on`, their captures and files) and to the camera warden (so a mid-run converge keeps them).
A run filmed only by the pair and a static cam asks for no bot cameras: `$env:AUREN_CAMERAS='none'`.
A run watched by the pair alone, no bot camera and no seat to fly, asks for `$env:AUREN_CAMERAS='pair'`: the
foreman raises the pair whatever the focus file's switch says, and the pair starts on the senior body the run
raises (`foreman_config.only` honoured), so a one-body run such as the T-1 march is followed from its first step:

```
$env:AUREN_CAMERAS='pair'; node start_auren.js --start rollback --only VedaBot --module t1 --difficulty normal --clock dawn --landing usual --soak 25 --record cameras
```

The rider's camera is released, carried to `Rd_Seat` and bound again every `rider.rebindMs`: a camera client can
drop its view of the rider while the server still holds the binding, and the server answers a plain re-spectate
of the same target as "already spectating" (seen 2026-11-13: the rider flew on and the window stood still).

**Reading what it did.** `trace_monitor.js --activities` lists every span with its exact start and end, through
the same board the director read live. The director's own record carries `[CAM_PAIR] 📊 focus` (each pick: bot,
kind, rank, what it left), `open` and `closed` (each span as the director saw it), `[CAM_SITE] 📊 site` (each
view taken: box centre, lens, pitch, how far the canopy raised it), and a narrated line for every pick
(`--narration --bot=camera_rig`). After a filmed run, `Cutting_room/hook_curator.js scan` writes the spans into the
take's `hook/moments.json` with each one's seconds in every camera file, marking the cameras that were on that
activity (its bot's own camera, and the pair while it was on that bot).

| Symptom | Where to look |
|---|---|
| the pair stays on the first bot all run | `--activities`: no spans means no body did a ranked activity, or every open kind is unticked on the page |
| it switches too often | `minDwellMs` in `camera_configure.js` `siteSeat`; the focus lines show what pre-empted what |
| the site cam did not move on a pick | the director's `site view … not solved` warning names why; the scout must be up to read the canopy |
| `Cam_Site` or `Cam_Rider` has no file in the take | the overlay's raise line names the seats it raised; the scout page's switch was off |
| `Cam_Rider` films one still spot; no `→ spectating Rd_Seat` line | `Rd_Seat` (and `Scout_Cam`) joined another server: a rig started by hand outside the launcher dials `AUREN_SERVER_PORT` (default 25565, the main seat) while its console link reads the copy's `server.properties`. Start it with `AUREN_SERVER_PORT` set to the seat's `server-port` |

## 11. The rider — a bot camera that follows its bot's route instead of cutting shots

`camera/camera_rider.js`, switched on with `AUREN_RIDER=on` in the environment of whatever starts the rig
(off by default; the knobs are the `rider` block of `camera_configure.js`). With it on, each bot camera
stops placing and cutting tripod shots. The rig instead raises one headless client per bot, `Rd_<Bot>`, and
spectates the camera onto it. The rider:

- **follows the bot's own track at a speed of its own.** It keeps the bot's track as distance travelled and
  holds `followBlocks` (4) behind along it. Its speed eases toward the bot's average speed (over
  `speedWindowSec`) plus a gap correction, with an acceleration ceiling (`maxAccel`), so a lurch or a corner
  pause of the bot never reaches the lens. Corners are averaged into arcs (`cornerBlocks`);
- **rides as high as it can still see the bot from.** Four times a second it tries heights from `highRise`
  (2.6 above the bot's eye) down to `lowRise` (0.4) and keeps the highest whose cell is open and whose line to
  the bot's chest is clear, by `sightline.js`, the same test as the scout and the gimbal. It lowers quickly
  (`boomDownSec`) and climbs back slowly (`boomUpSec`). The ground under it ignores the bot's jumps;
- **looks where the bot is going, not at the bot.** The navigator posts the next 32 cells of its route as
  `[ROUTE] 📊 ahead cells=x,y,z/...` on the bot's story file; the rider aims at the route point
  `lookAheadBlocks` ahead, falling back to the bot's direction of travel when it has no route or is off it.
  The aim is eased and turn-rate capped (`maxTurnDegPerSec`, `pitchMaxDeg`);
- **never stands nearer the bot than `standoffBlocks` (3.5) across the ground**, measured from the bot itself,
  not along its track. A bot that walks back over its own track (a fight's strafe and knockback, a detour round a
  trunk) used to walk into a lens still "4 blocks behind". When the track spot comes within `crowdBlocks` (3.5) of
  the bot, or the bot has a fight open on the
  pair's activity board, the rider **holds off** for `leashHoldSec` (4 s; a fight, all of it): it leaves the track and
  stays where it is between `standoffBlocks` and `leashMaxBlocks` (6), backing straight away when the bot comes at
  it and following when it pulls away, and swings round the bot (`leashOrbitDegPerSec`) when no height at its bearing
  sees the bot. Holding off, it looks at the bot, not along the route. The hand-over is eased (`leashBlendSec`); the
  floor is not, and measures from the bot as last heard. The held spot measures from the bot eased by
  `botEaseSec` (0.1 s). Measured on the T-1 march of 2026-11-14 (floor then on the eased bot): the plain track
  spot came as near as 0.05 b and was inside 3 b up to 100% of a 30 s window; the lens never nearer than 2.76 b.
  On that fight-heavy march it held off the whole night, and the Architect called the rider excellent;
- **looks for a bot it has lost behind leaves (LOST SIGHT)** when the bot stands or fights in place (moved under
  `seekStillBlocks`, 1.5 b, in the last second) and the lens has not seen its chest for `seekAfterMs` (1.5 s). A
  moving bot carries the lens out of a canopy by itself; a still one did not (the Architect saw a T-1 fight three
  skeletons and a zombie as leaves only). The lens holds off and, every `seekSearchMs` (1 s), tries bearings outward
  from its own in `seekBearingStepDeg` (20°) steps round to the far side, at three distances between `standoffBlocks`
  and `leashMaxBlocks`, from `seekHighRise` (4.4) down to `seekLowRise` (−0.8) about the bot's eye, and turns to the
  first clear view at `seekDegPerSec` (25°/s). With none found it sweeps `seekSweepDeg` (90°) to each side and rises and
  falls once every `seekBobSec` (6 s) until the chest comes into view, then stays until the bot moves. The rig's
  `rider_distance` row carries `blindSec`, `seeks` and `seekFound`;
- **moves in 10 ms steps through an ordinary client**, so the camera's game client in-betweens it like any
  other entity it watches. Nothing teleports the camera while it rides;
- **writes its own position packet every step**, and holds back mineflayer's 50 ms ones. The server passes
  on whatever position it holds at its tick; a 50 ms sender drifts in phase against those ticks, so the
  relayed steps come short, long, short, which the camera shows as a pulse.

When the rider is more than `regrabBlocks` from its spot (a bot teleport, a respawn), the rig moves it there by
console and then **re-binds the camera in full: release, teleport the camera to the rider, spectate again.**
A plain re-spectate of the same target does not do it: the camera's client keeps viewing the rider's old
place and floats outside its loaded chunks (seen live 2026-11-06).

```powershell
$env:AUREN_RIDER='on'; $env:AUREN_CAMERAS='1'   # then start the run as usual
```

**How near it stood:** every `distanceReportMs` (30 s) the rig records `rider_distance` on its own record for each
rider: `lensMin` (nearest the lens stood to the bot across the ground), `trackMin` (nearest the plain track spot
would have stood: the rider without the hold-off, on the same walk), `lensUnderPct` / `trackUnderPct` (share of
steps more than half a block inside `standoffBlocks`) and `holdSec`.

**Measuring it without footage:** `tools/locomotion_course.js --observe=1 --bot=Rd_<Bot>` follows the rider
and reports head-turn rates, turn-backs, speed change (blocks/s², over 1 s windows) and relayed step
evenness (how much each relayed move differs from the one before). `--reduce-last` reads the newest tape
again. Starting an observe clears the previous tape, so compare takes one at a time. On a 135-block hill
walk (2026-11-06) the rider read: head turn p95 56, max 92 deg/s; speed change p95 1.7 blocks/s²;
step-to-step change p50 13%, p95 21%. The bot itself on the same walk: speed change p95 2.0, step-to-step
change p50 33%.

**Capturing on the dedicated box:** its blank screensaver owns the screen and every capture fails with
"error 5" or "handle is invalid". Stop `scrnsave.scr` first. Then capture the window by title with
`-vf crop=trunc(iw/2)*2:trunc(ih/2)*2`; the window's 1061-pixel height is refused by the H.264 encoder.
