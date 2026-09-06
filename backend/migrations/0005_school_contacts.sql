-- Who your admissions officer is, per school (Phase 6.5).
--
-- Columns on school_notes rather than a school_contacts table, which is what
-- the implementation guide describes: "a small addition to the existing
-- per-school note, reusing that infrastructure." The pair (student, school) is
-- already this table's primary key and already the thing five pages edit, so a
-- contact is another field on the notepad the student already has open — not a
-- second record to go and find.
--
-- The cost of that choice, stated plainly: one contact per school. A student
-- who deals with both a regional counselor and a departmental one has to pick.
-- If that turns out to matter, the fix is a school_contacts table and these two
-- columns get migrated into it; it is a cheap migration to do later and a
-- needless table to build now.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No email, no phone, no last-contacted date. The first two are a third
-- party's personal contact details, and a college counselor did not consent to
-- being in this database — a name and a job title are what the student needs to
-- remember and are already public on the school's own site. Without a date this
-- is an attribution rather than a tracker; that is a deliberate scope choice,
-- not an oversight.
--
-- Both nullable, and both default to the empty string on write rather than
-- NULL, so "" and NULL never both mean "no contact" — one of them would
-- eventually be missed by a check.

ALTER TABLE school_notes ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE school_notes ADD COLUMN contact_role TEXT NOT NULL DEFAULT '';
