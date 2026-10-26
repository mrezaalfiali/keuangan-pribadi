"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Edit2, NotebookPen, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent } from "@/src/components/ui/card";
import { Input, Textarea } from "@/src/components/ui/input";
import { createClient } from "@/src/lib/supabase/client";
import { logSupabaseError } from "@/src/lib/supabase/errors";

type NoteKind = "general" | "finance";

interface Note {
  id: string;
  user_id: string;
  title: string;
  content: string;
  kind: NoteKind;
  created_at: string;
  updated_at: string;
}

function isMissingNotesTable(error: { code?: string }) {
  return error.code === "42P01" || error.code === "PGRST205";
}

export function NotesPage() {
  const locale = useLocale();
  const t = useTranslations("notes");
  const common = useTranslations("common");
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<NoteKind>("general");
  const [editingNote, setEditingNote] = useState<Note | null>(null);

  useEffect(() => {
    let active = true;

    async function loadNotes() {
      setLoading(true);
      setLoadError("");
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("notes")
          .select("id, user_id, title, content, kind, created_at, updated_at")
          .order("updated_at", { ascending: false });

        if (error) {
          logSupabaseError("notes.load", error);
          if (active) setLoadError(isMissingNotesTable(error) ? "migrationMissing" : "loadError");
          return;
        }
        if (active) setNotes((data ?? []) as Note[]);
      } catch (error) {
        logSupabaseError("notes.load", error);
        if (active) setLoadError("loadError");
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadNotes();
    return () => {
      active = false;
    };
  }, []);

  function resetForm() {
    setEditingNote(null);
    setTitle("");
    setContent("");
    setKind("general");
    setFeedback("");
  }

  function startEditing(note: Note) {
    setEditingNote(note);
    setTitle(note.title);
    setContent(note.content);
    setKind(note.kind);
    setFeedback("");
  }

  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFeedback("");

    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      if (authError) logSupabaseError("notes.auth", authError);
      setFeedback("authError");
      setSaving(false);
      return;
    }

    const values = {
      title: title.trim(),
      content: content.trim(),
      kind,
    };
    const query = editingNote
      ? supabase
          .from("notes")
          .update(values)
          .eq("id", editingNote.id)
          .eq("user_id", user.id)
      : supabase
          .from("notes")
          .insert({ ...values, user_id: user.id });
    const { data, error } = await query
      .select("id, user_id, title, content, kind, created_at, updated_at")
      .single();

    if (error) {
      logSupabaseError("notes.save", error);
      setFeedback(isMissingNotesTable(error) ? "migrationMissing" : "saveError");
      setSaving(false);
      return;
    }

    const savedNote = data as Note;
    setNotes((current) => {
      const next = editingNote
        ? current.map((note) => note.id === savedNote.id ? savedNote : note)
        : [savedNote, ...current];
      return next.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
    resetForm();
    setSaving(false);
  }

  async function deleteNote(note: Note) {
    if (!window.confirm(t("deleteConfirm", { title: note.title }))) return;
    setFeedback("");

    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      if (authError) logSupabaseError("notes.auth", authError);
      setFeedback("authError");
      return;
    }

    const { data, error } = await supabase
      .from("notes")
      .delete()
      .eq("id", note.id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();

    if (error) {
      logSupabaseError("notes.delete", error);
      setFeedback(isMissingNotesTable(error) ? "migrationMissing" : "deleteError");
      return;
    }
    if (!data) {
      setFeedback("deleteError");
      return;
    }
    setNotes((current) => current.filter((item) => item.id !== note.id));
    if (editingNote?.id === note.id) resetForm();
  }

  const dateFormatter = new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </header>

      {loadError ? (
        <Card>
          <CardContent className="p-5 text-sm text-danger">
            {t(loadError)}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <NotebookPen size={18} className="text-accent" />
                <h2 className="font-display text-lg font-semibold text-ink">
                  {editingNote ? t("editTitle") : t("newTitle")}
                </h2>
              </div>
              <form onSubmit={saveNote} className="space-y-4">
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
                  {t("noteTitle")}
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={120}
                    required
                    placeholder={t("titlePlaceholder")}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
                  {t("type")}
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as NoteKind)}
                    className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                  >
                    <option value="general">{t("general")}</option>
                    <option value="finance">{t("finance")}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
                  {t("content")}
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    maxLength={5000}
                    rows={5}
                    required
                    placeholder={t("contentPlaceholder")}
                  />
                </label>
                {feedback && <p role="alert" className="text-sm text-danger">{t(feedback)}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={saving}>
                    <Plus size={16} />
                    {saving ? common("loading") : editingNote ? common("save") : t("addNote")}
                  </Button>
                  {editingNote && (
                    <Button type="button" variant="outline" onClick={resetForm} disabled={saving}>
                      <X size={16} />
                      {common("cancel")}
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          <section aria-labelledby="notes-list-title">
            <h2 id="notes-list-title" className="mb-3 font-display text-lg font-semibold text-ink">
              {t("listTitle")}
            </h2>
            {loading ? (
              <p className="text-sm text-muted">{common("loading")}</p>
            ) : notes.length === 0 ? (
              <Card>
                <CardContent className="p-5 text-sm text-muted">{t("empty")}</CardContent>
              </Card>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {notes.map((note) => (
                  <li key={note.id}>
                    <Card className="h-full">
                      <CardContent className="flex h-full flex-col p-5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <span className="inline-flex rounded-full bg-surface2 px-2.5 py-1 text-[11px] font-medium text-muted">
                              {t(note.kind)}
                            </span>
                            <h3 className="mt-2 break-words font-semibold text-ink">{note.title}</h3>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => startEditing(note)}
                              aria-label={`${common("edit")}: ${note.title}`}
                            >
                              <Edit2 size={16} />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-danger hover:text-danger"
                              onClick={() => void deleteNote(note)}
                              aria-label={`${common("delete")}: ${note.title}`}
                            >
                              <Trash2 size={16} />
                            </Button>
                          </div>
                        </div>
                        <p className="mt-3 flex-1 whitespace-pre-wrap break-words text-sm text-muted">
                          {note.content}
                        </p>
                        <time className="mt-4 text-xs text-faint" dateTime={note.updated_at}>
                          {dateFormatter.format(new Date(note.updated_at))}
                        </time>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
