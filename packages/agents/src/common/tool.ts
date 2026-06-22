// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * A tool definition with its implementation function.
 *
 * `definition` is a native Anthropic tool — the agent loop passes it straight
 * to `anthropic.messages.create({ tools })` with no conversion step.
 */
export type ToolWithFunc = {
  definition: Anthropic.Tool;
  func: (input: unknown) => unknown | Promise<unknown>;
};

/**
 * Creates a native Anthropic tool from a zod schema.
 *
 * The zod schema is compiled to JSON Schema for the wire `input_schema`. We drop
 * the top-level `$schema` meta key (Anthropic ignores it; omitting it keeps the
 * definition minimal) and keep the rest verbatim.
 */
export const tool = <T extends z.ZodObject<z.ZodRawShape>>({
  name,
  description,
  schema,
  func,
}: {
  name: string;
  description: string;
  schema: T;
  func: (input: z.infer<T>) => unknown | Promise<unknown>;
}): ToolWithFunc => {
  const { $schema: _$schema, ...inputSchema } = zodToJsonSchema(schema) as Record<string, unknown>;
  return {
    definition: {
      name,
      description,
      input_schema: inputSchema as Anthropic.Tool.InputSchema,
    },
    func: func as (input: unknown) => unknown | Promise<unknown>,
  };
};
