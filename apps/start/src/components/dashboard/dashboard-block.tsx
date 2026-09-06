import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/utils/cn';
import type { DashboardBlockContent } from '@openpanel/validation';
import {
  CopyIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { dashboardBlockViews } from './blocks';

export { dashboardBlockViews, getDashboardBlockSearchText } from './blocks';

interface DashboardBlockProps {
  block: { id: string } & DashboardBlockContent;
  onSave: (values: DashboardBlockContent) => Promise<unknown>;
  reveal?: boolean;
  onRevealed?: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function DashboardBlock({
  block,
  onSave,
  reveal = false,
  onRevealed,
  onDuplicate,
  onDelete,
}: DashboardBlockProps) {
  const [editing, setEditing] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const contentRef = useRef<HTMLButtonElement>(null);
  const view = dashboardBlockViews[block.kind];
  const Editor = view.Editor;

  useEffect(() => {
    if (!reveal) return;
    setHighlighted(true);
    if (Editor) {
      editingRef.current = true;
      setEditing(true);
    }
    const frame = requestAnimationFrame(() => {
      const target = Editor
        ? blockRef.current?.firstElementChild
        : blockRef.current;
      target?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: 'center',
      });
      onRevealed?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, Editor, onRevealed]);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(false), 2400);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  const startEditing = () => {
    editingRef.current = true;
    setEditing(true);
  };

  const closeEditor = (restoreFocus = false) => {
    editingRef.current = false;
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => contentRef.current?.focus());
  };

  return (
    <div
      ref={blockRef}
      data-dashboard-block
      data-editing={editing}
      className={cn(
        'group relative h-full w-full rounded-md',
        editing && 'z-20',
        highlighted && !editing && 'bg-primary/5 ring-2 ring-primary/40',
      )}
    >
      {editing && Editor ? (
        <Editor
          block={block}
          onSave={onSave}
          onClose={closeEditor}
          className={highlighted ? 'ring-2 ring-primary/40' : undefined}
        />
      ) : Editor ? (
        <button
          ref={contentRef}
          type="button"
          aria-label={`Edit ${view.label.toLowerCase()}`}
          className="block h-full w-full overflow-auto rounded-md py-1 pl-2 pr-6 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={startEditing}
        >
          {view.render(block)}
        </button>
      ) : (
        view.render(block)
      )}
      {!editing && (
        <div className="absolute right-6 top-0 z-10 flex rounded-md bg-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
                aria-label={`${view.label} options`}
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
              {Editor && (
                <DropdownMenuItem onSelect={startEditing}>
                  <PencilIcon size={14} />
                  Edit {view.label.toLowerCase()}
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
