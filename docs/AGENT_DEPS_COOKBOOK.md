# Agent Dependencies Cookbook

Copy-pasteable `install.deps` recipes for the cases you will actually hit. There are no shorthand `apt:` / `npm:` / `pip:` DSLs — every dependency is declared as an explicit `install:` block, which keeps cross-image expectations honest and the build cache key precise.

Each recipe below is a self-contained entry under `install.deps`. Copy it, adjust the URL/version, and ship it. For the field reference, the linkage taxonomy, and how deps mount and resolve on `PATH`, see [The Environment Model](./ENVIRONMENT.md#install-deps-installdeps).

A quick reminder on `linkage` (the portability contract):

- **`static`** — fully self-contained binary, including libc. Runs on any base image with the right CPU arch. No `abi` block.
- **`closure`** — self-contained except for libc. Requires `abi.libc` (`glibc` or `musl`). The dominant case for language runtimes.
- **`dynamic`** — depends on substrate libraries beyond libc. Declare them via `requires.libraries`. Rare; reach for `closure` first.

## 1. GitHub release static binary (the dominant case)

```yaml
- name: ripgrep
  version: "14.1.1"
  image: debian:bookworm-slim
  linkage: static
  provides:
    binaries: [rg]
  install:
    - target: linux/amd64
      run:
        - apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates
        - curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz -o /tmp/rg.tgz
        - mkdir -p /tmp/rg && tar -xzf /tmp/rg.tgz -C /tmp/rg
        - cp /tmp/rg/ripgrep-14.1.1-x86_64-unknown-linux-musl/rg /output/bin/rg
        - chmod +x /output/bin/rg
```

## 2. Single-file `curl -O` for tiny tools

```yaml
- name: jq
  version: "1.7.1"
  image: debian:bookworm-slim
  linkage: static
  provides:
    binaries: [jq]
  install:
    - target: linux/amd64
      run:
        - apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates
        - curl -fsSL https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 -o /output/bin/jq
        - chmod +x /output/bin/jq
```

## 3. Archive (tar.gz / tar.xz / zip) extraction

Same shape as #1 — the only difference is the extraction tool. For `.tar.xz` use `tar -xJf`; for `.zip` add `unzip` to the apt install line and use `unzip -d /tmp/extract`. Mark `linkage: static` only when the resulting binary really is fully self-contained; otherwise mark it `closure` with the appropriate `abi`.

## 4. `apt install` + extract from a build container

Use this when the upstream tool only publishes apt packages and you want the binaries on `PATH` at run time. The resulting binary is glibc-dynamic — mark it `closure` with `abi.libc: glibc` so the cross-image expectations are honest.

```yaml
- name: tree
  version: "2.1.1"
  image: debian:bookworm-slim
  linkage: closure
  abi:
    libc: glibc
  provides:
    binaries: [tree]
  install:
    - target: linux/amd64
      run:
        - apt-get update -qq && apt-get install -y -qq --no-install-recommends tree
        - cp /usr/bin/tree /output/bin/tree
```

## 5. `npm install` + extract (bundled Node)

If your agent ships its own Node (see [Shipping a language runtime](#shipping-a-language-runtime)), reach `node` via the dep's PATH. The launcher script can call `node` and trust the deps PATH to resolve it. Otherwise — for purely demonstrative agents that intentionally trust substrate Node — the agent will only work on images that supply Node.

```yaml
- name: prettier
  version: "3.3.3"
  image: node:20-bookworm-slim
  linkage: closure
  abi:
    libc: glibc
  install:
    - target: linux/amd64
      run:
        - mkdir -p /tmp/install /output/lib /output/bin
        - npm install --prefix /tmp/install --no-audit --no-fund --no-progress prettier@3.3.3
        - cp -a /tmp/install/node_modules /output/lib/
        - |
          cat > /output/bin/prettier <<'WRAP'
          #!/bin/sh
          exec node /bunsen/deps/prettier/lib/node_modules/prettier/bin/prettier.cjs "$@"
          WRAP
        - chmod +x /output/bin/prettier
```

## 6. `pip install` + extract (bundled Python)

Same shape as #5 but with `pip install --target` and a shell shim. Pair with a shipped Python dep so the agent works against any substrate.

```yaml
- name: black
  version: "24.10.0"
  image: python:3.11-bookworm
  linkage: closure
  abi:
    libc: glibc
  install:
    - target: linux/amd64
      run:
        - pip install --no-cache-dir --target /output/lib black==24.10.0
        - |
          cat > /output/bin/black <<'WRAP'
          #!/bin/sh
          exec python -m black --no-cache "$@"
          WRAP
        - chmod +x /output/bin/black
```

## Shipping a language runtime

This is the canonical pattern for closure agents. An agent that needs Node, Python, Ruby, etc. ships the runtime itself rather than depending on substrate to provide it.

### Node via the official Linux tarball (glibc closure)

```yaml
- name: node
  version: "20.18.1"
  description: Official Node.js binary distribution (glibc closure)
  image: debian:bookworm-slim
  linkage: closure
  abi:
    libc: glibc
    libc_version: ">=2.28"
  provides:
    binaries: [node, npm, npx, corepack]
  install:
    - target: linux/amd64
      run:
        - apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils
        - curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/node.tar.xz
        - mkdir -p /tmp/node-extract && tar -xJf /tmp/node.tar.xz -C /tmp/node-extract --strip-components=1
        - mkdir -p /output/bin /output/lib /output/include /output/share
        - cp -a /tmp/node-extract/bin/. /output/bin/
        - cp -a /tmp/node-extract/lib/. /output/lib/
        - cp -a /tmp/node-extract/include/. /output/include/
        - cp -a /tmp/node-extract/share/. /output/share/
    - target: linux/arm64
      run: [...]   # same shape, arm64 tarball
```

### Python via `python-build-standalone` (glibc closure)

Astral's [`python-build-standalone`](https://github.com/astral-sh/python-build-standalone) ships portable, relocatable CPython builds. The amd64 / arm64 `gnu` builds are glibc closures suitable for every Bunsen base image.

```yaml
- name: python
  version: "3.11.10"
  description: Astral python-build-standalone distribution (glibc closure)
  image: debian:bookworm-slim
  linkage: closure
  abi:
    libc: glibc
    libc_version: ">=2.31"
  provides:
    binaries: [python, python3, pip, pip3]
  install:
    - target: linux/amd64
      run:
        - apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates
        - curl -fsSL https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz -o /tmp/py.tar.gz
        - mkdir -p /tmp/py-extract && tar -xzf /tmp/py.tar.gz -C /tmp/py-extract
        - mkdir -p /output/bin /output/lib
        - cp -a /tmp/py-extract/python/bin/. /output/bin/
        - cp -a /tmp/py-extract/python/lib/. /output/lib/
        - /output/bin/pip3 install --no-cache-dir --target /output/lib/python3.11/site-packages anthropic
```

### Static binary tools

For tools published as fully-static (musl) Linux binaries — Go binaries, Rust musl builds — use `linkage: static` with no `abi` block. The dep runs on any glibc or musl base.

### musl-targeted closure for Alpine compatibility

If your agent must run on Alpine (musl) substrates, declare `abi.libc: musl` and download the musl build of your runtime. Bunsen does not validate libc compatibility at build time — the field is recorded; you are trusted to match it to the substrate.

## See also

- [The Environment Model](./ENVIRONMENT.md) — concepts, the `install.deps` field reference, and how deps compose with the experiment substrate.
- [agent.yaml Reference](./AGENT_YAML.md) — the full agent config schema.
- [Platforms & Architecture](./PLATFORMS.md) — how Bunsen resolves a single platform for dep builds and cache keys.
