-- Two conversations per student, not one (Phase 6.3).
--
-- The essay brainstorm assistant is a second chatbot mode over the same
-- llmService, and the thing that makes it a *second* assistant rather than a
-- differently-worded prompt is that it keeps its own thread. Without this
-- column both modes append to one history, and every essay question arrives at
-- the model wrapped in whatever the student last asked about the FAFSA —
-- context that actively degrades the answer, and a transcript that reads as
-- one confused conversation.
--
-- NOT NULL DEFAULT 'advising' rather than a nullable column: existing rows are
-- all advising turns, and a NULL here would mean "belongs to neither thread",
-- which is a state no query wants to think about. SQLite backfills every
-- existing row with the default as part of the ALTER, so the migration is its
-- own backfill and there is no second statement to forget.
--
-- Deliberately a free TEXT column with no CHECK constraint: a third mode
-- (Phase 6's roadmap has a few candidates) should be a code change, not
-- another migration. The values are validated in src/models/chatMode.ts, which
-- is also where the list of them lives for the API to reject unknown ones.

ALTER TABLE messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'advising';

-- The old index is (student_id, seq), which no longer matches how these rows
-- are read: every query is now "one student's turns, in one mode, in order".
-- Leaving it would make SQLite scan a student's whole history and filter the
-- other mode out by hand — cheap at 40 rows, and the wrong shape to leave
-- behind either way.
DROP INDEX IF EXISTS messages_by_student;
CREATE INDEX IF NOT EXISTS messages_by_student_mode ON messages(student_id, mode, seq);
