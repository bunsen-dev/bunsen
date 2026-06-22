// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Build-agent command — prebuild `install.build` artifacts for an agent.
 */

import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  parseAgentVariantSyntax,
  resolveAgent,
  describeSearchedLocations,
  loadAgent,
  resolveAgentSource,
  buildAgentArtifacts,
} from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat } from '../format.js';

interface BuildAgentOptions {
  rebuild?: boolean;
  platform?: string;
  format?: string;
}

export async function buildAgentCommand(
  agentArg: string,
  options: BuildAgentOptions,
): Promise<void> {
  const spinner = ora();
  const machine = isMachineFormat(resolveFormat(options));
  try {
    const cwd = process.cwd();
    const [agentName, variantName] = parseAgentVariantSyntax(agentArg);
    const resolved = resolveAgent(agentName);
    if (!resolved) {
      console.error(chalk.red(`Agent not found: ${agentName}`));
      console.error(chalk.dim(describeSearchedLocations('agent')));
      process.exit(1);
    }

    const agent = loadAgent(resolved.path, { variant: variantName });

    let resolvedAgentPath = resolved.path;
    if (agent.install.source.type !== 'local') {
      spinner.start('Resolving agent source...');
      resolvedAgentPath = await resolveAgentSource(agent, cwd, (msg) => {
        spinner.text = msg;
      });
    }

    spinner.start('Building agent artifacts...');
    const result = await buildAgentArtifacts(agent, {
      agentPath: resolvedAgentPath,
      baseDir: cwd,
      platform: options.platform,
      rebuild: options.rebuild,
      onProgress: (msg) => {
        spinner.text = msg;
      },
    });
    spinner.stop();

    if (!result) {
      if (machine) {
        const { renderMachine } = await import('../format.js');
        process.stdout.write(
          renderMachine(
            {
              agent: agent.name,
              variant: variantName,
              built: false,
              reason: 'Agent defines neither install.deps nor install.build',
            },
            options.format === 'yaml' ? 'yaml' : 'json',
          ),
        );
        return;
      }
      console.log(
        chalk.yellow(`Agent "${agent.name}" has no install.deps or install.build configuration.`),
      );
      return;
    }

    const { artifactsPath, deps } = result;
    const metadataPath = artifactsPath ? path.join(artifactsPath, 'metadata.json') : undefined;
    const metadata =
      metadataPath && fs.existsSync(metadataPath)
        ? JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
        : null;

    if (machine) {
      const { renderMachine } = await import('../format.js');
      process.stdout.write(
        renderMachine(
          {
            agent: agent.name,
            variant: variantName,
            built: true,
            ...(artifactsPath ? { artifactsPath } : {}),
            ...(metadataPath && fs.existsSync(metadataPath) ? { metadataPath } : {}),
            ...(metadata ? { metadata } : {}),
            deps: deps.map((d) => ({
              name: d.name,
              ...(d.version !== undefined ? { version: d.version } : {}),
              cacheKey: d.cacheKey,
              artifactsPath: d.artifactsPath,
              cacheHit: d.cacheHit,
              binaries: d.binaries,
            })),
          },
          options.format === 'yaml' ? 'yaml' : 'json',
        ),
      );
      return;
    }

    console.log(
      chalk.green(`Built artifacts for ${agent.name}${variantName ? `:${variantName}` : ''}`),
    );
    if (deps.length > 0) {
      console.log(chalk.dim(`Deps (${deps.length}):`));
      for (const dep of deps) {
        const tag = dep.version ? `${dep.name}@${dep.version}` : dep.name;
        const hit = dep.cacheHit ? 'cached' : 'built';
        console.log(chalk.dim(`  - ${tag} (${hit}, ${dep.cacheKey})`));
      }
    }
    if (artifactsPath) {
      console.log(chalk.dim(`Artifacts: ${artifactsPath}`));
      if (metadata && typeof metadata.cacheKey === 'string') {
        console.log(chalk.dim(`Cache key: ${metadata.cacheKey}`));
      }
    }
  } catch (error) {
    spinner.fail('Build-agent failed');
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
