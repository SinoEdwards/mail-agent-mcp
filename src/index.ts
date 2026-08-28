import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { ImapService } from './services/imap-service.js';
import { AccountManager } from './services/account-manager.js';
import { SmtpService } from './services/smtp-service.js';
import { SpamService } from './services/spam-service.js';
import { registerTools } from './tools/index.js';
import { AccountAuthResolver } from './credentials/account-auth.js';
import { createGmailAccessTokenExchange } from './credentials/gmail-token-exchange.js';
import { UnavailableCredentialBackend, WindowsCredentialBackend } from './credentials/windows-credential-backend.js';

// Silence any package version output to stdout
const originalWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as any) = function(chunk: any, encoding?: any, callback?: any): boolean {
  // Only allow JSON-RPC messages through
  if (typeof chunk === 'string' && (chunk.startsWith('{') || chunk === '\n')) {
    return originalWrite(chunk, encoding, callback);
  }
  return true;
};

dotenv.config();

const server = new McpServer({
  name: 'mail-agent-mcp',
  version: '0.1.0',
});

const credentialBackend = process.platform === 'win32'
  ? new WindowsCredentialBackend()
  : new UnavailableCredentialBackend();
const authResolver = new AccountAuthResolver(
  credentialBackend,
  createGmailAccessTokenExchange({ credentials: credentialBackend }),
);
const imapService = new ImapService(authResolver);
const accountManager = new AccountManager(credentialBackend);
const smtpService = new SmtpService(authResolver);
const spamService = new SpamService();

// Allow ImapService to auto-connect using stored credentials
imapService.setAccountManager(accountManager);

// Register all tools
registerTools(server, imapService, accountManager, smtpService, spamService);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mail Agent MCP started');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
