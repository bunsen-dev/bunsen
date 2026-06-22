<!-- Generated from https://schemas.bunsen.dev/agent.v1.json — do not edit by hand. -->

# agent.yaml — field reference (v1)

Authoritative field list, generated from the JSON Schema your installed `bn` ships.
`bn experiments validate` / `bn agents validate` is the oracle: if anything here
disagrees with what `bn … validate` accepts, trust `bn`.

Notation: `` `name`: type `` lists a field; **(required)** marks required fields;
a `` `name` `` type links to its definition section below.

## agent.yaml (top level)

- `$schema`: string
- `version`: `"v1"` **(required)**
- `name`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `description`: string
- `install`: `install` **(required)**
- `entrypoint`: `entrypoint` **(required)**
- `interaction`: `interaction` **(required)**
- `model`: `model`
- `defaults`: `agentDefaults`
- `examples`: array of `agentExample`
- `variants`: map<string, `variant`>
- _no other fields allowed_

## duration

string — pattern `^\d+(?:\.\d+)?(?:ms|s|m|h)$`.

## executionUser

String, one of: `"user"`, `"root"`.

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

## installSourceLocal

- `type`: `"local"` **(required)**
- _no other fields allowed_

## installSourceGit

- `type`: `"git"` **(required)**
- `repo`: string **(required)** — minLength 1
- `ref`: string — minLength 1
- _no other fields allowed_

## installSourceNpm

- `type`: `"npm"` **(required)**
- `package`: string **(required)** — minLength 1
- `version`: string — minLength 1
- _no other fields allowed_

## installSourceBinary

- `type`: `"binary"` **(required)**
- `url`: string **(required)** — minLength 1
- `sha256`: string — pattern `^[A-Fa-f0-9]{64}$`
- _no other fields allowed_

## installSource

One of:
- `installSourceLocal`
- `installSourceGit`
- `installSourceNpm`
- `installSourceBinary`

## buildConfig

- `image`: string **(required)** — minLength 1
- `network`: `"default"` | `"none"`
- `timeout`: `duration`
- `run`: array of string **(required)** — minItems 1
- `cacheSalt`: string
- _no other fields allowed_

## install

- `source`: `installSource` **(required)**
- `deps`: array of `agentDep`
- `build`: `buildConfig`
- `configure`: array of `step`
- _no other fields allowed_

## agentDepFileRef

- `file`: string **(required)** — minLength 1
- _no other fields allowed_

## agentDepInstall

- `target`: string **(required)** — minLength 1
- `image`: string — minLength 1
- `network`: `"default"` | `"none"`
- `timeout`: `duration`
- `run`: array of string **(required)** — minItems 1
- _no other fields allowed_

## agentDepProvides

- `binaries`: array of string
- _no other fields allowed_

## agentDepLinkage

String, one of: `"static"`, `"closure"`, `"dynamic"`.

## agentDepAbi

- `libc`: `"glibc"` | `"musl"` **(required)**
- `libc_version`: string — minLength 1
- _no other fields allowed_

## agentDepLibraryRequirement

- `name`: string **(required)** — minLength 1
- `version`: string — minLength 1
- _no other fields allowed_

## agentDepRequires

- `libraries`: array of `agentDepLibraryRequirement`
- _no other fields allowed_

## agentDepSpec

- `name`: string **(required)** — pattern `^[a-z0-9][a-z0-9-]*$`
- `version`: string — minLength 1
- `description`: string
- `image`: string — minLength 1
- `linkage`: `agentDepLinkage`
- `abi`: `agentDepAbi`
- `requires`: `agentDepRequires`
- `provides`: `agentDepProvides`
- `install`: array of `agentDepInstall` **(required)** — minItems 1
- _no other fields allowed_

## agentDep

One of:
- `agentDepFileRef`
- `agentDepSpec`

## entrypoint

- `command`: string **(required)** — minLength 1
- `args`: array of string
- `help`: string — minLength 1
- _no other fields allowed_

## interaction

- `mode`: `"direct"` | `"supervised"` **(required)**
- _no other fields allowed_

## model

- `env`: string **(required)** — pattern `^[A-Za-z_][A-Za-z0-9_]*$`
- `default`: string — minLength 1
- _no other fields allowed_

## agentDefaults

- `env`: map<string, string>
- `passEnv`: array of string
- _no other fields allowed_

## agentExample

- `prompt`: string **(required)** — minLength 1
- `invocation`: string **(required)** — minLength 1
- _no other fields allowed_

## variant

- `description`: string
- `install`: object
  - `source`: `variantInstallSource`
  - `deps`: array of `agentDep`
  - `build`: `buildConfig`
  - `configure`: `variantConfigureSteps`
  - _no other fields allowed_
- `entrypoint`: object
  - `command`: string — minLength 1
  - `args`: array of string
  - `help`: string — minLength 1
  - _no other fields allowed_
- `interaction`: object
  - `mode`: `"direct"` | `"supervised"`
  - _no other fields allowed_
- `defaults`: `agentDefaults`
- _no other fields allowed_

## variantInstallSource

One of:
- `installSource`
- object { ref, version }

## variantConfigureSteps

One of:
- array of `step`
- object { mergeMode, items }
