import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/utils/cn';
import {
  CopyIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface DashboardBlockProps {
  block: { id: string; kind: string; heading: string; body: string };
  onSave: (values: { heading: string; body: string }) => Promise<unknown>;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function DashboardBlock({
  block,
  onSave,
  onDuplicate,
  onDelete,
}: DashboardBlockProps) {
  const [editing, setEditing] = useState(false);
  const [heading, setHeading] = useState(block.heading);
  const [body, setBody] = useState(block.body);
  const [saving, setSaving] = useState(false);
  const editingRef = useRef(false);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLButtonElement>(null);
  const isDivider = block.kind === 'divider';

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEditing = () => {
    setHeading(block.heading);
    setBody(block.body);
    editingRef.current = true;
    setEditing(true);
  };

  const closeEditor = () => {
    editingRef.current = false;
    setEditing(false);
  };

  const save = async (restoreFocus = false) => {
    if (!editingRef.current || savingRef.current) return;
    const values = { heading: heading.trim(), body: body.trim() };
    if (values.heading === block.heading && values.body === block.body) {
      closeEditor();
      if (restoreFocus)
        requestAnimationFrame(() => contentRef.current?.focus());
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(values);
      closeEditor();
      if (restoreFocus)
        requestAnimationFrame(() => contentRef.current?.focus());
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
      data-editing={editing}
      className={cn(
        'group relative h-full w-full rounded-md',
        editing && 'z-20',
      )}
    >
      {editing ? (
        <div
          className="absolute inset-0 z-20 flex min-h-44 flex-col gap-2 rounded-md border bg-card p-2 shadow-md"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) void save();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape' && !savingRef.current) {
              event.preventDefault();
              event.stopPropagation();
              closeEditor();
              requestAnimationFrame(() => contentRef.current?.focus());
            } else if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey)
            ) {
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
            <Button variant="ghost" disabled={saving} onClick={closeEditor}>
              Cancel
            </Button>
            <Button loading={saving} onClick={() => void save(true)}>
              Save
            </Button>
          </div>
        </div>
      ) : isDivider ? (
        <div
          className="flex h-full min-h-[13px] items-center"
          role="separator"
          aria-label="Dashboard section divider"
        >
          <div className="w-full border-t" />
        </div>
      ) : (
        <button
          ref={contentRef}
          type="button"
          aria-label="Edit text block"
          className="block h-full min-h-[42px] w-full overflow-auto rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={startEditing}
        >
          {block.heading && (
            <span className="block whitespace-pre-wrap break-words text-lg font-semibold">
              {block.heading}
            </span>
          )}
          {block.body && (
            <span className="block whitespace-pre-wrap break-words text-sm">
              {block.body}
            </span>
          )}
          {!block.heading && !block.body && (
            <span className="text-sm text-muted-foreground">Add text…</span>
          )}
        </button>
      )}
      {!editing && (
        <div className="absolute right-1 top-0 z-10 flex rounded-md bg-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <div
            className="drag-handle flex h-6 w-6 cursor-move items-center justify-center text-muted-foreground"
            title="Drag to move block"
            aria-hidden="true"
          >
            <GripVerticalIcon size={14} />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={
                  isDivider ? 'Divider options' : 'Text block options'
                }
              >
                <MoreHorizontalIcon size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (editingRef.current) event.preventDefault();
              }}
            >
              {!isDivider && (
                <DropdownMenuItem onSelect={startEditing}>
                  <PencilIcon size={14} />
                  Edit text
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onDuplicate}>
                <CopyIcon size={14} />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <TrashIcon size={14} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
