import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { RocketIcon } from 'lucide-react';

import CopyInput from '../forms/copy-input';

type Props = { id: string; secret: string; type?: string };

export function CreateClientSuccess({ id, secret, type }: Props) {
  // read/root clients can drive the MCP server; give them the ready-to-paste
  // token (base64(clientId:clientSecret)) so they don't have to encode it.
  const isMcpCapable = type === 'read' || type === 'root';
  const mcpToken = isMcpCapable && secret ? btoa(`${id}:${secret}`) : undefined;

  return (
    <div className="grid gap-4">
      <CopyInput label="Client ID" value={id} />
      {secret && (
        <div className="w-full">
          <CopyInput label="Secret" value={secret} />
          <p className="mt-1 text-sm text-muted-foreground">
            You will only need the secret if you want to send server events.
          </p>
        </div>
      )}
      {mcpToken && (
        <div className="w-full">
          <CopyInput label="MCP token" value={mcpToken} />
          <p className="mt-1 text-sm text-muted-foreground">
            Paste this into your AI client (Settings → MCP). Shown only once —
            copy it now.
          </p>
        </div>
      )}
      <Alert>
        <RocketIcon className="h-4 w-4" />
        <AlertTitle>Get started!</AlertTitle>
        <AlertDescription>
          Read our{' '}
          <a
            target="_blank"
            href="https://openpanel.dev/docs"
            className="underline"
            rel="noreferrer"
          >
            documentation
          </a>{' '}
          to get started. Easy peasy!
        </AlertDescription>
      </Alert>
    </div>
  );
}
