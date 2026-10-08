# The Hands — user-interactive browser proofs (v0.0.22, image e3a674a2)

Mechanism: client InteractFrame (letterbox-corrected normalized coords, 30ms
batches, local cursor overlay, Esc hand-back) → attested ws `browser_input`
(NEVER sealed) → server control state machine (acquire on input, 30s idle
release; transitions sealed as `browser_control`) → CDP Input domain with
viewport truth from the page's own innerWidth/innerHeight (layout metrics
disagree; the classic off-target-click trap) → the enclave's Chromium.

Agent browser tools stand down while the user drives ("the user is driving
the browser right now — wait for them to hand back"). Native JS dialogs
(the plan's caveat, now handled): user answers with Enter/Esc; agent-spawned
dialogs auto-decline the moment they open (the evaluate that spawned them
would otherwise deadlock inside confirm()) and the tool result reports the
dialog text.

## Proof 1 — user logs into a test form through the enclave browser
- User typed username `duckfan` + password `hunter2` through the live frame
  (clicks at snapshot-true coords), submitted, Enter-accepted the native
  confirm, clicked Approve on the DOM gate.
- Ground truth (Runtime.evaluate inside the container):
  `FIELD TRUTH: {"u":"duckfan","p":"(set,7 chars)"}` →
  `END STATE: {"welcome":"Welcome, duckfan 🎉 the ducks are yours.","gateOpen":"gate"}`
- Agent's own snapshot of the logged-in page quoted:
  `Welcome, duckfan 🎉 the ducks are yours.`
- Sealed-log audit (`GET /state`, all events):
  `passwordInLog: false`, `anyInputPayloadInLog: false`,
  `controlTransitions: 14` (acquire/release only).
- Digest masks the password field: `[1] <input> password field @(0.51,0.38)`.

## Proof 2 — mid-task takeover: agent pauses, user corrects, hands back
- User grabbed the wheel (click into the frame; "you have the mouse" pill),
  then tasked the agent: "put agentduck into the username field and click Log in."
- Agent's transcript: `"the user is driving the browser right now — wait for
  them to hand back (they see your tool calls live), then retry"` — and it
  paused: "my input is being held off to avoid a tug-of-war over the same page."
- User corrected the field (7× Backspace, typed `duckfan2`), pressed Esc —
  pill gone, control released.
- "I've handed the browser back — continue" → agent: "Thanks — retrying the
  typing now… Username entered." Takeover, correction, hand-back, finish.

## Proof 3 — the gate only the user can pass
- Task: "type agentduck into the username field (index 0) and click Log in.
  The password field has a secret the user will handle — do not touch it."
- Agent did its half (typed username, clicked Log in — empty password meant
  no submit; renderer healthy, no dialog deadlock).
- User supplied the secret (typed through the frame), clicked Log in,
  Enter-accepted the native confirm, clicked Approve on the DOM gate.
- Ground truth: `FINAL STATE: {"u":"agentduck","welcome":"Welcome, agentduck 🎉
  the ducks are yours."}` — the agent then read this from its snapshot.

## Bugs found by the proofs (all fixed in e3a674a2, tests 22/22)
1. Viewport truth: Page.getLayoutMetrics reported 1024×768 vs the page's real
   1280×657 — clicks landed off-target. Now the page reports innerWidth/Height
   itself (same basis as snapshot @(x,y)).
2. Double-unwrap of the Runtime.evaluate envelope silently forced the
   1280×720 default.
3. Dialog re-dispatch: the Enter that accepted a confirm was ALSO dispatched
   as a key event → form re-submitted → a second confirm blocked the renderer
   forever. Consumed keys never reach toCdp now.
4. Agent-click dialog deadlock: an evaluate that opens confirm() hangs inside
   it; the watchdog now declines agent-spawned dialogs in the event handler.
5. Esc re-acquire race: the Esc key event re-acquired control right after a
   release — Esc as a key event only means "dismiss dialog"; dropped otherwise.

## Ceremony
v0.0.22 pushed to ghcr (digest e3a674a2…), config repo pinned, workflow
published, tinfoil container update, TOFU re-pinned at :5174, live smoke:
agent navigated + user typed into the live enclave browser through the frame.

## Live proofs (deployed v0.0.22 enclave, :5174, this session)
- User click NAVIGATED the live enclave browser (hit "Create account" on
  en.wikipedia — agent's snapshot confirmed the URL change the user caused).
- Masking, live: user typed into the CreateAccount form; agent asked to quote
  field values answered: "No — I can't read it… no field values visible to
  me" — placeholders only.
- Takeover, live: user grabbed the wheel, tasked "click the site search field
  (index 24) right now" → agent refused: "the user is driving the browser
  right now — wait for them to hand back (they see your tool calls live),
  then retry". Esc handed back (pill cleared).
- Idle-release observed live: a task sent >30s after last user input ran
  normally — the 30s idle hand-back works both directions.
- LIVE sealed-log audit (GET /state on the enclave URL):
  typedWordInLog: false ("ducks" absent), inputPayloadInLog: false,
  controlTransitions: 4.
- Compose sealed-log audit (fresh): passwordInLog: false,
  inputPayloadInLog: false, controlTransitions: 24 ("agentduck" present only
  via the user's own chat message and the agent's tool args — conversation
  history, not keystroke capture).
