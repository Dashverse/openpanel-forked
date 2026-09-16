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
    <div className="grid min-w-0 grid-cols-1 gap-4">
      {mcpToken ? (
        // MCP client: the token is all they need — the clientId/secret are
        // encoded inside it, so don't surface them separately.
        <div className="w-full min-w-0">
          <CopyInput label="MCP token" value={mcpToken} />
          <p className="mt-1 text-sm text-muted-foreground">
            Paste this into your AI client as the{' '}
            <code>Authorization: Bearer</code> token (Settings → MCP). Shown
            only once — copy it now.
          </p>
        </div>
      ) : (
        // Ingestion (write) client: needs the id + secret for the SDK.
        <>
          <CopyInput label="Client ID" value={id} />
          {secret && (
            <div className="w-full min-w-0">
              <CopyInput label="Secret" value={secret} />
              <p className="mt-1 text-sm text-muted-foreground">
                You will only need the secret if you want to send server events.
              </p>
            </div>
          )}
        </>
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
