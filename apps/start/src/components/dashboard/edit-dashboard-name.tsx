import { Input } from '@/components/ui/input';
import { handleErrorToastOptions, useTRPC } from '@/integrations/trpc/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function EditDashboardName({
  id,
  name,
  projectId,
}: {
  id: string;
  name: string;
  projectId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const editingRef = useRef(false);
  const restoreFocus = useRef(false);
  const mutation = useMutation(
    trpc.dashboard.update.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess(updated) {
        queryClient.setQueryData(
          trpc.dashboard.byId.queryKey({ id, projectId }),
          (current) => current && { ...current, name: updated.name },
        );
        queryClient.invalidateQueries(trpc.dashboard.pathFilter());
      },
    }),
  );

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreFocus.current) {
      buttonRef.current?.focus();
      restoreFocus.current = false;
    }
  }, [isEditing]);

  const finishEditing = (save: boolean, focusTitle = false) => {
    if (!editingRef.current) return;
    editingRef.current = false;
    restoreFocus.current = focusTitle;
    setIsEditing(false);
    const nextName = draft.trim();
    if (save && nextName && nextName !== name) {
      mutation.mutate({ id, name: nextName });
    }
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        aria-label="Dashboard name"
        className="h-8 max-w-xl text-2xl font-semibold"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finishEditing(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finishEditing(event.key === 'Enter', true);
          }
        }}
      />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Rename dashboard: ${name}`}
      aria-disabled={mutation.isPending}
      className="group flex min-h-8 cursor-pointer items-center gap-2 text-left"
      onClick={() => {
        if (mutation.isPending) return;
        setDraft(name);
        editingRef.current = true;
        setIsEditing(true);
      }}
    >
      {name}
      <PencilIcon
        size={16}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}
