<!-- Generated from https://schemas.bunsen.dev/experiment.v1.json — do not edit by hand. -->

# experiment.yaml — field reference (v1)

Authoritative field list, generated from the JSON Schema your installed `bn` ships.
`bn experiments validate` / `bn agents validate` is the oracle: if anything here
disagrees with what `bn … validate` accepts, trust `bn`.

Notation: `` `name`: type `` lists a field; **(required)** marks required fields;
a `` `name` `` type links to its definition section below.

## experiment.yaml (top level)

- `$schema`: string
- `version`: `"v1"` **(required)**
- `name`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `description`: string
- `labels`: map<string, string>
- `task`: `task` **(required)**
- `workspace`: `workspace`
- `environment`: `environment` **(required)**
- `run`: `run`
- `evaluation`: `evaluation` **(required)**
- `env`: map<string, string>
- `passEnv`: array of string
- `variants`: map<string, `variant`>
- _no other fields allowed_

## duration

string — pattern `^\d+(?:\.\d+)?(?:ms|s|m|h)$`.

## platform

String, one of: `"linux/amd64"`, `"linux/arm64"`.

## executionUser

String, one of: `"user"`, `"root"`.

## task

- `prompt`: string **(required)** — minLength 1
- _no other fields allowed_

## step

One of:
- `runStep`
- `writeFileStep`

## runStep

- `run`: string **(required)** — minLength 1
- `as`: `executionUser`
- `timeout`: `duration`
- _no other fields allowed_

## writeFileStep

- `writeFile`: string **(required)** — minLength 1
- `from`: string — minLength 1
- `content`: string
- `as`: `executionUser`
- `timeout`: `duration`
- _no other fields allowed_

Requires exactly one of: `from`  —or—  `content`.

## workspaceSource

- `path`: string — minLength 1
- `imagePath`: string — minLength 1
- `target`: string — minLength 1
- _no other fields allowed_

Requires exactly one of: `path`  —or—  `imagePath`.

## workspace

- `sources`: array of `workspaceSource`
- `setup`: array of `step`
- _no other fields allowed_

## packages

- `apt`: array of string
- `npm`: array of string
- `pip`: array of string
- `cargo`: array of string
- _no other fields allowed_

## runtimes

object.

## requires

- `runtimes`: `runtimes`
- `packages`: `packages`
- _no other fields allowed_

## environmentImage

- `base`: string — minLength 1
- `dockerfile`: string — minLength 1
- _no other fields allowed_

Requires exactly one of: `base`  —or—  `dockerfile`.

## environment

- `image`: `environmentImage` **(required)**
- `requires`: `requires`
- `platforms`: array of `platform` — minItems 1
- `user`: `executionUser`
- _no other fields allowed_

## run

- `timeout`: `duration`
- `platform`: `"auto"` | `platform`
- `artifactCaptureTimeout`: `duration`
- _no other fields allowed_

## allowedScores

One of:
- array of number
- map<string, string>

## criterionNeeds

One of:
- `"all"`
- array of string

## criterionGate

- `ifBelow`: number **(required)**
- _no other fields allowed_

## criterionBase

- `id`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `title`: string **(required)** — minLength 1
- `type`: string **(required)**
- `timeout`: `duration`
- `weight`: number — min 0
- `scores`: `allowedScores`
- `needs`: `criterionNeeds`
- `gate`: `criterionGate`

## scriptCriterion

_Extends `criterionBase`._

- `id`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `title`: string **(required)** — minLength 1
- `type`: `"script"` **(required)**
- `timeout`: `duration`
- `weight`: number — min 0
- `scores`: `allowedScores`
- `needs`: `criterionNeeds`
- `gate`: `criterionGate`
- `run`: string **(required)** — minLength 1
- _no other fields allowed_

## judgeCriterion

_Extends `criterionBase`._

- `id`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `title`: string **(required)** — minLength 1
- `type`: `"judge"` **(required)**
- `timeout`: `duration`
- `weight`: number — min 0
- `scores`: `allowedScores`
- `needs`: `criterionNeeds`
- `gate`: `criterionGate`
- `instructions`: string **(required)** — minLength 1
- `evidence`: array of `"diff"` | `"logs"` | `"traces"`
- `scorer`: object
  - `model`: string
  - _no other fields allowed_
- _no other fields allowed_

## agentScorer

- `model`: string
- `tools`: array of string
- _no other fields allowed_

## agentCriterion

_Extends `criterionBase`._

- `id`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `title`: string **(required)** — minLength 1
- `type`: `"agent"` **(required)**
- `timeout`: `duration`
- `weight`: number — min 0
- `scores`: `allowedScores`
- `needs`: `criterionNeeds`
- `gate`: `criterionGate`
- `instructions`: string **(required)** — minLength 1
- `scorer`: `agentScorer`
- _no other fields allowed_

## browserAgentCriterion

_Extends `criterionBase`._

- `id`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `title`: string **(required)** — minLength 1
- `type`: `"browser-agent"` **(required)**
- `timeout`: `duration`
- `weight`: number — min 0
- `scores`: `allowedScores`
- `needs`: `criterionNeeds`
- `gate`: `criterionGate`
- `instructions`: string **(required)** — minLength 1
- `scorer`: `agentScorer`
- _no other fields allowed_

## aggregateCriterion

_Extends `criterionBase`._

- `id`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `title`: string **(required)** — minLength 1
- `type`: `"aggregate"` **(required)**
- `timeout`: `duration`
- `weight`: number — min 0
- `scores`: `allowedScores`
- `needs`: `criterionNeeds` **(required)**
- `gate`: `criterionGate`
- `aggregate`: object **(required)**
  - `function`: `"weighted_average"` | `"all"` | `"any"` | `"min"` | `"max"` **(required)**
  - _no other fields allowed_
- _no other fields allowed_

## criterion

One of:
- `scriptCriterion`
- `judgeCriterion`
- `agentCriterion`
- `browserAgentCriterion`
- `aggregateCriterion`

## report

- `model`: string
- `evidence`: array of `"diff"` | `"logs"` | `"traces"`
- `instructions`: string **(required)** — minLength 1
- `needs`: `criterionNeeds`
- `timeout`: `duration`
- _no other fields allowed_

## evaluation

- `container`: `"dedicated"` | `"agent"`
- `criteria`: array of `criterion` **(required)**
- `report`: `report`
- _no other fields allowed_

## variant

- `description`: string
- `labels`: map<string, string>
- `task`: object
  - `prompt`: string
  - _no other fields allowed_
- `workspace`: `workspace`
- `environment`: object
  - `image`: `environmentImage`
  - `requires`: `requires`
  - `platforms`: array of `platform` — minItems 1
  - `user`: `executionUser`
  - _no other fields allowed_
- `run`: `run`
- `evaluation`: object
  - `container`: `"dedicated"` | `"agent"`
  - `criteria`: array of `criterion`
  - `report`: `report`
  - _no other fields allowed_
- `env`: map<string, string>
- `passEnv`: array of string
- _no other fields allowed_
