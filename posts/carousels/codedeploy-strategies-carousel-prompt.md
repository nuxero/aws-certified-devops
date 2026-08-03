# LinkedIn Carousel Prompt: CodeDeploy Deployment Strategies

## Prompt

Generate a 9-slide LinkedIn carousel. Portrait format (1080×1350px). Dark theme with a charcoal/dark navy background (#1a1a2e or #0f0f23), white text for headings, light gray (#e0e0e0) for body text. Accent color: AWS orange (#FF9900) for highlights and key terms. Secondary accent: teal (#4CC9F0) for diagrams and icons. Sans-serif font, bold headings. One concept per slide. Minimal — no stock photos, no clutter. Add a subtle slide counter in the bottom-right corner (1/9, 2/9, etc.). Export as a multi-page PDF.

---

### Slide 1 — Cover

Large bold title: "4 AWS Deployment Strategies"
Subtitle below in lighter weight: "From Risky to Bulletproof"
Visual: four horizontal bars stacked vertically, progressing from red (top) to green (bottom), labeled:
- AllAtOnce
- OneAtATime
- HalfAtATime
- Blue/Green

At the bottom, a single line in italic gray: "Same app. Same fleet. Completely different risk profiles."

---

### Slide 2 — The Problem

Heading: "Deployments need to be fast AND safe"

Body:
• Fast → deliver value quickly
• Safe → don't break things for users
• These goals pull in opposite directions
• Deployment strategy = where you land on that spectrum

Visual: a horizontal slider/spectrum bar:
- Left end labeled "FAST" (orange)
- Right end labeled "SAFE" (teal/green)
- A marker in the middle with a "?" indicating the choice

---

### Slide 3 — AllAtOnce

Heading: "Strategy 1: AllAtOnce"
Subheading in orange: "Fastest. Riskiest."

Visual: a row of 3 server icons, ALL turning orange simultaneously (indicating update in progress)

Key facts (large text, bullet points):
• Deploys to every instance at the same time
• Succeeds if even ONE instance passes
• Entire fleet runs unvalidated code simultaneously
• Rollback = full redeploy (slow)

Bottom label: "Use for: dev/test environments where downtime is acceptable"

---

### Slide 4 — OneAtATime

Heading: "Strategy 2: OneAtATime"
Subheading in teal: "Slowest. Safest."

Visual: a row of 3 server icons — first one turning green (done), second one orange (in progress), third one gray (waiting)

Key facts:
• Updates one instance, waits for success, moves to next
• If any instance fails (except the last) → full stop
• At most 1 instance running unvalidated code at any time
• Rollback = stop + redeploy remaining

Bottom label: "Use for: small production fleets where time cost is acceptable"

---

### Slide 5 — HalfAtATime

Heading: "Strategy 3: HalfAtATime"
Subheading in white: "The balanced middle ground"

Visual: a row of 6 server icons — first 3 turning green (done as a batch), last 3 gray (waiting for next batch)

Key facts:
• Deploys to 50% of fleet, waits for success, then the other 50%
• Never exposes entire fleet at once
• Faster than OneAtATime, safer than AllAtOnce
• You can also create custom configs (e.g., keep 75% healthy)

Bottom label: "Use for: larger production fleets that need balanced speed/safety"

---

### Slide 6 — Blue/Green

Heading: "Strategy 4: Blue/Green"
Subheading in green: "Zero downtime. Instant rollback."

Visual: a two-row diagram:
- Top row: ALB → "Blue fleet (current)" in blue boxes
- Bottom row: ALB → "Green fleet (new)" in green boxes
- A curved arrow showing traffic switching from blue to green

Key facts:
• Spins up entirely NEW instances (green)
• Deploys to green while blue still serves traffic
• Switches ALB to green once healthy
• Rollback = switch ALB back (seconds, not minutes)

Bottom label: "Use for: production with zero-tolerance for downtime"

---

### Slide 7 — Blue/Green tradeoffs

Heading: "Blue/Green isn't free"

Body (honest tradeoff list):
• 2× instance cost during deployment (both fleets running)
• Slower than in-place (new instances must launch + health check)
• Requires an Auto Scaling Group — not available for on-premises
• Fresh instances every deploy = no configuration drift (a benefit)

Visual: a simple cost icon or dollar sign with "2×" next to it, balanced against a clock icon showing "instant rollback"

---

### Slide 8 — Comparison Table

Heading: "Side by side"

A styled comparison table (one row per strategy, columns highlighted with color):

| Strategy | Downtime? | Rollback | Cost | Best for |
|----------|-----------|----------|------|----------|
| AllAtOnce | Possible | Slow (full redeploy) | 1× | Dev/test |
| OneAtATime | None | Medium | 1× | Small prod, max safety |
| HalfAtATime | None | Medium | 1× | Larger fleets, balanced |
| Blue/Green | None | Instant (ALB switch) | 2× | Zero-tolerance prod |

Make this table visually prominent — this is the slide people will screenshot.

---

### Slide 9 — Decision Tree + CTA

Heading: "Quick decision framework"

A simple flowchart with 3 questions:

```
Need instant rollback?
  → YES: Blue/Green
  → NO: ↓

Cost-sensitive?
  → YES: OneAtATime or custom minimum healthy %
  → NO: ↓

Dev environment?
  → YES: AllAtOnce
  → NO: HalfAtATime or custom config
```

Footer at bottom:
"Full walkthrough with hands-on deployment of all 4 → link in comments"
"Follow for more AWS DevOps content"

---

## End of prompt
