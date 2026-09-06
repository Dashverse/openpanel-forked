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
import { useRef, useState } from 'react';
import { dashboardBlockViews } from './blocks';

export { dashboardBlockViews, getDashboardBlockSearchText } from './blocks';

interface DashboardBlockProps {
  block: { id: string } & DashboardBlockContent;
  onSave: (values: DashboardBlockContent) => Promise<unknown>;
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
  const editingRef = useRef(false);
  const contentRef = useRef<HTMLButtonElement>(null);
  const view = dashboardBlockViews[block.kind];
  const Editor = view.Editor;

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
      data-dashboard-block
      data-editing={editing}
      className={cn(
        'group relative h-full w-full rounded-md',
        editing && 'z-20',
      )}
    >
      {editing && Editor ? (
        <Editor block={block} onSave={onSave} onClose={closeEditor} />
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
