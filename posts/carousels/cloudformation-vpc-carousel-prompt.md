# LinkedIn Carousel Prompt: CloudFormation Template Anatomy

## Prompt

Generate a 10-slide LinkedIn carousel. Portrait format (1080×1350px). Dark theme with a charcoal/dark navy background (#1a1a2e or #0f0f23), white text for headings, light gray (#e0e0e0) for body text. Accent color: AWS orange (#FF9900) for highlights and key terms. Secondary accent: teal (#4CC9F0) for diagrams and icons. Sans-serif font, bold headings. One concept per slide. Minimal — no stock photos, no clutter. Add a subtle slide counter in the bottom-right corner (1/10, 2/10, etc.). Export as a multi-page PDF.

---

### Slide 1 — Cover

Large bold title: "CloudFormation Template Anatomy"
Subtitle below in lighter weight: "Explained in 10 Slides"
At the top, a small layered graphic: three boxes labeled "CDK", "SAM", "StackSets" stacked above a single box labeled "CloudFormation Template" with a downward arrow connecting them.
At the bottom, a single line in italic gray: "The abstraction always leaks. Know what's underneath."

---

### Slide 2 — The 7 Sections

Heading: "7 sections. Only 1 is required."

A vertical numbered list styled as stacked blocks or cards:

1. AWSTemplateFormatVersion
2. Description
3. Parameters
4. Mappings
5. Conditions
6. Resources — this one highlighted with an orange border and a small "REQUIRED" badge
7. Outputs

Items 1-5 and 7 in gray/muted. Item 6 in white/orange to draw the eye.

---

### Slide 3 — Parameters

Heading: "Parameters → reusable templates"

Body (short bullet points, large text):
• Inputs the deployer provides at deploy time
• Types: String, Number, List, AWS-specific (VPC IDs, AMIs)
• Constrain with AllowedValues, AllowedPattern, Min/Max
• Use when the value changes per deployment

Small visual on the right or bottom: a simple key-value input showing:
Environment = "prod"

---

### Slide 4 — Mappings

Heading: "Mappings → author-controlled lookup tables"

Body:
• Two-level key → key → value structure
• Accessed with !FindInMap
• Deployer can't override them
• Use for values determined by another known key

Visual: a small styled table:
```
dev  → SubnetBits: 8  → /24 (256 IPs)
prod → SubnetBits: 12 → /20 (4096 IPs)
```

---

### Slide 5 — Conditions

Heading: "Conditions → resources that may not exist"

Body:
• Boolean logic evaluated at deploy time
• Condition: false = resource is entirely absent
• Functions: !Equals, !And, !Or, !Not, !If

Visual: a simple two-path flowchart:
```
Environment = prod?
  → YES: NAT Gateway created ✓
  → NO:  NAT Gateway doesn't exist ✗ (saves $33/mo)
```
Use green checkmark and red X with the respective paths.

---

### Slide 6 — Intrinsic Functions

Heading: "The 8 functions you'll use everywhere"

A clean two-column grid (function name in orange, description in white):

!Ref → resource ID or param value
!GetAtt → specific resource attribute
!Sub → string interpolation
!Join → concatenate a list
!Select → pick item by index
!FindInMap → lookup from Mappings
!Cidr → split CIDR into subnets
!GetAZs → list availability zones

---

### Slide 7 — !Cidr (deep dive)

Heading: "Let's zoom into one: !Cidr"
Subheading: "Stop calculating subnet ranges by hand"

Code snippet (large, syntax-highlighted):
```yaml
!Cidr [VPC CIDR, count, hostBits]
```

Below it, two examples:
• hostBits = 8 → /24 subnets (256 addresses)
• hostBits = 12 → /20 subnets (4,096 addresses)

Visual at bottom: a rectangle labeled "10.0.0.0/16" splitting into 4 smaller colored blocks representing subnets, each labeled with its CIDR.

---

### Slide 8 — Architecture

Heading: "Example: a production VPC from a single template"
Subheading: "Parameters, Mappings, Conditions, and Resources working together"

Full-slide architecture diagram with CloudFormation annotations:
- Top: cloud icon labeled "Internet"
- Below it: box labeled "Internet Gateway"
- Two columns for AZ1 and AZ2
- Each column has: a green box "Public Subnet" and a blue box "Private Subnet"
- A box labeled "NAT Gateway" with a dashed orange border

Key difference from a generic VPC diagram — add callout annotations pointing to specific parts:
- Arrow pointing to subnet CIDRs with annotation: "!Cidr + Mappings → derived automatically per environment"
- Arrow pointing to NAT Gateway's dashed border with annotation: "Condition: CreateNat → only exists in prod"
- Arrow pointing to VPC/subnet IDs at the bottom with annotation: "Outputs + Export → consumed by other stacks"

These annotations are what make it a CloudFormation diagram, not just a networking diagram.

---

### Slide 9 — Outputs

Heading: "Outputs → stacks that talk to each other"

Body:
• Expose values after stack creation
• Export: makes them importable by other stacks
• Convention: ${StackName}-OutputName (avoids collisions)
• Can't delete a stack with consumed exports

Visual: two stack icons (labeled "Network Stack" and "App Stack") with an arrow between them labeled "!ImportValue vpc-id"

---

### Slide 10 — Decision Framework + CTA

Heading: "When to use what"

Three rows, each with a colored label:

🟠 Parameters → deployer chooses at deploy time
  (environment, CIDR, instance type)

🔵 Mappings → author controls, keyed off another value
  (subnet sizing per env, AMI per region)

⚪ Hardcoded → never changes
  (DNS settings, 0.0.0.0/0)

Footer at bottom:
"Full walkthrough with deployable template → link in comments"
"Follow for more AWS DevOps content"

---

## End of prompt
