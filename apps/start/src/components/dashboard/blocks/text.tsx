import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/utils/cn';
import { dashboardBlockDefinitions } from '@openpanel/validation';
import { TypeIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DashboardBlockEditorProps, DashboardBlockView } from './types';

function TextBlockEditor({
  className,
  block,
  onSave,
  onClose,
}: DashboardBlockEditorProps) {
  const config = dashboardBlockDefinitions.text.schema.parse(block.config);
  const [heading, setHeading] = useState(config.heading);
  const [body, setBody] = useState(config.body);
  const [saving, setSaving] = useState(false);
  const activeRef = useRef(true);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const close = (restoreFocus = false) => {
    activeRef.current = false;
    onClose(restoreFocus);
  };

  const save = async (restoreFocus = false) => {
    if (!activeRef.current || savingRef.current) return;
    const values = { heading: heading.trim(), body: body.trim() };
    if (values.heading === config.heading && values.body === config.body) {
      close(restoreFocus);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave({ kind: 'text', config: values });
      close(restoreFocus);
    } catch {
      // The mutation displays the error; retain the draft so it can be retried.
      inputRef.current?.focus();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        'absolute inset-0 z-20 flex min-h-44 flex-col gap-2 rounded-md border bg-card p-2 shadow-md',
        className,
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) void save();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && !savingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          void save(true);
        }
      }}
    >
      <Input
        ref={inputRef}
        aria-label="Text block heading"
        placeholder="Heading"
        maxLength={500}
        value={heading}
        readOnly={saving}
        onChange={(event) => setHeading(event.target.value)}
      />
      <Textarea
        aria-label="Text block body"
        placeholder="Add notes…"
        maxLength={50000}
        className="min-h-16 flex-1 resize-none"
        value={body}
        readOnly={saving}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-1">
        <Button variant="ghost" disabled={saving} onClick={() => close(true)}>
          Cancel
        </Button>
        <Button loading={saving} onClick={() => void save(true)}>
          Save
        </Button>
      </div>
    </div>
  );
}

export const textBlockView: DashboardBlockView = {
  label: 'Text block',
  icon: TypeIcon,
  Editor: TextBlockEditor,
  getSearchText: (block) => {
    const { heading, body } = dashboardBlockDefinitions.text.schema.parse(
      block.config,
    );
    return `${heading} ${body}`;
  },
  render: (block) => {
    const { heading, body } = dashboardBlockDefinitions.text.schema.parse(
      block.config,
    );
    return (
      <>
        {heading && (
          <span className="block whitespace-pre-wrap break-words text-lg font-semibold">
            {heading}
          </span>
        )}
        {body && (
          <span
            className={cn(
              'block whitespace-pre-wrap break-words text-sm',
              heading && 'mt-2',
            )}
          >
            {body}
          </span>
        )}
        {!heading && !body && (
          <span className="text-sm text-muted-foreground">Add text…</span>
        )}
      </>
    );
  },
};
