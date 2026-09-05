"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea, Label } from "@/components/ui/input";
import { Card, CardTitle } from "@/components/ui/card";

export interface TeamMember {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: string;
}

import { Assignment } from "@/lib/types";

interface Note {
  id: string;
  author_name: string | null;
  content: string;
  created_at: string;
}

export function AssignDropdown({
  reportId,
  teamMembers,
  currentAssignment,
  onAssigned,
}: {
  reportId: string;
  teamMembers: TeamMember[];
  currentAssignment: Assignment | null;
  onAssigned?: () => void;
}) {
  const [selectedAssignee, setSelectedAssignee] = useState(currentAssignment?.assignee_id || "");
  const [busy, setBusy] = useState(false);

  async function handleAssign() {
    if (!selectedAssignee) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/authority/incidents/${reportId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId: selectedAssignee }),
      });
      if (res.ok) {
        onAssigned?.();
      }
    } catch (error) {
      console.error("Assign failed:", error);
    } finally {
      setBusy(false);
    }
  }

  function handleUnassign() {
    setSelectedAssignee("");
    handleAssign();
  }

  return (
    <Card>
      <CardTitle className="mb-2">Assign to Team Member</CardTitle>
      <div className="space-y-3">
        <div>
          <Label>Assignee</Label>
          <Select value={selectedAssignee} onChange={(e) => setSelectedAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {teamMembers.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.display_name || m.email} ({m.role})
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleAssign} disabled={busy || !selectedAssignee}>
            {busy ? "Assigning..." : "Assign"}
          </Button>
          {currentAssignment?.assignee_id && (
            <Button variant="secondary" onClick={handleUnassign} disabled={busy}>
              Unassign
            </Button>
          )}
        </div>
        {currentAssignment?.assignee_id && (
          <p className="text-sm text-gray-500">
            Currently assigned to: <strong>{currentAssignment.assignee_name || currentAssignment.assignee_email}</strong>
          </p>
        )}
      </div>
    </Card>
  );
}

export function NotesSection({ reportId, notes, onNoteAdded }: { reportId: string; notes: Note[]; onNoteAdded?: () => void }) {
  const [newNote, setNewNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleAddNote() {
    if (!newNote.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/authority/incidents/${reportId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newNote.trim() }),
      });
      if (res.ok) {
        setNewNote("");
        onNoteAdded?.();
      }
    } catch (error) {
      console.error("Add note failed:", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle className="mb-2">Notes & Comments</CardTitle>
      <div className="space-y-3">
        <div>
          <Label>Add Note</Label>
          <Textarea
            rows={3}
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Add a note about this incident..."
          />
        </div>
        <Button onClick={handleAddNote} disabled={busy || !newNote.trim()}>
          {busy ? "Adding..." : "Add Note"}
        </Button>

        {notes.length > 0 && (
          <div className="space-y-3 border-t pt-3">
            {notes.map((note) => (
              <div key={note.id} className="bg-gray-50 rounded p-3">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium">{note.author_name || "Unknown"}</span>
                  <span className="text-gray-500">{new Date(note.created_at).toLocaleString()}</span>
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{note.content}</p>
              </div>
            ))}
          </div>
        )}

        {notes.length === 0 && <p className="text-sm text-gray-400">No notes yet.</p>}
      </div>
    </Card>
  );
}