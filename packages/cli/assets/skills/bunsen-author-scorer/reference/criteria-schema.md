<!-- Generated from https://schemas.bunsen.dev/experiment.v1.json — do not edit by hand. -->

# Evaluation criteria — field reference (v1)

Authoritative field list, generated from the JSON Schema your installed `bn` ships.
`bn experiments validate` / `bn agents validate` is the oracle: if anything here
disagrees with what `bn … validate` accepts, trust `bn`.

Notation: `` `name`: type `` lists a field; **(required)** marks required fields;
a `` `name` `` type links to its definition section below.

## evaluation

- `container`: `"dedicated"` | `"agent"`
- `criteria`: array of `criterion` **(required)**
- `report`: `report`
- _no other fields allowed_

## duration

string — pattern `^\d+(?:\.\d+)?(?:ms|s|m|h)$`.

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
