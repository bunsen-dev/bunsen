// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Create Anthropic client with proxy support and source tagging.
 *
 * When HTTPS_PROXY/HTTP_PROXY env vars are set, configures undici's ProxyAgent
 * so requests route through the mitmproxy sidecar for trace capture.
 *
 * When BUNSEN_TRACE_SOURCE is set, adds X-Bunsen-Source header so the proxy
 * can tag traces as "platform" vs "agent".
 */

import Anthropic from '@anthropic-ai/sdk';
import { ProxyAgent } from 'undici';

export function createAnthropicClient(apiKey: string): Anthropic {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  return new Anthropic({
    apiKey,
    defaultHeaders: {
      ...(process.env.BUNSEN_TRACE_SOURCE && { 'X-Bunsen-Source': process.env.BUNSEN_TRACE_SOURCE }),
    },
    ...(proxyUrl && {
      fetchOptions: {
        dispatcher: new ProxyAgent({
          uri: proxyUrl,
          requestTls: {
            // Trust the mitmproxy CA cert (NODE_EXTRA_CA_CERTS handles this at the Node.js level,
            // but ProxyAgent needs explicit rejectUnauthorized for the tunneled TLS connection)
            rejectUnauthorized: false,
          },
        }),
      },
    }),
  });
}
