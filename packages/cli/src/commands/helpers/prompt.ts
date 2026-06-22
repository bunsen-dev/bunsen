// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import * as readline from 'node:readline';

/** Create a readline interface bound to stdin/stdout. */
export function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

/** Ask a question on an existing readline interface; resolves the trimmed answer. */
export function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Yes/no confirmation, defaulting to NO (empty or anything but y/yes → false). */
export function confirm(question: string): Promise<boolean> {
  const rl = createRl();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/** Yes/no confirmation, defaulting to YES (empty input → true). */
export function confirmDefaultYes(question: string): Promise<boolean> {
  const rl = createRl();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}
