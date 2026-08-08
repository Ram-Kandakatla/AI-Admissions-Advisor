// Simple in-memory data store for the MVP.
// Universities are loaded once from JSON; student profiles and chat history
// live in memory and reset when the server restarts. This is deliberately
// swappable for a real database later (same function signatures).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UNIVERSITIES_PATH = path.join(__dirname, "..", "data", "universities.json");

let universitiesCache = null;
const students = new Map(); // id -> profile
const conversations = new Map(); // studentId -> [{ role, content, at }]
const applications = new Map(); // studentId -> [{ id, universityId, ... }]

function loadUniversities() {
  if (!universitiesCache) {
    const raw = fs.readFileSync(UNIVERSITIES_PATH, "utf-8");
    universitiesCache = JSON.parse(raw);
  }
  return universitiesCache;
}

// ---- Students ----

function createStudent(profile) {
  const id = crypto.randomUUID();
  const record = { id, ...profile, createdAt: new Date().toISOString() };
  students.set(id, record);
  return record;
}

function getStudent(id) {
  return students.get(id) || null;
}

function updateStudent(id, profile) {
  const existing = students.get(id);
  if (!existing) return null;
  const record = {
    ...existing,
    ...profile,
    id,
    updatedAt: new Date().toISOString(),
  };
  students.set(id, record);
  return record;
}

// ---- Conversations ----

function getConversation(studentId) {
  if (!conversations.has(studentId)) {
    conversations.set(studentId, []);
  }
  return conversations.get(studentId);
}

function appendMessage(studentId, role, content) {
  const convo = getConversation(studentId);
  convo.push({ role, content, at: new Date().toISOString() });
  // Keep memory bounded — retain the most recent 40 turns.
  if (convo.length > 40) convo.splice(0, convo.length - 40);
  return convo;
}

// ---- Applications ----
//
// One list per student. A student can only track a given university once —
// picking a different decision plan for the same school is an edit, not a
// second application.

function getApplications(studentId) {
  if (!applications.has(studentId)) {
    applications.set(studentId, []);
  }
  return applications.get(studentId);
}

function findApplication(studentId, applicationId) {
  return getApplications(studentId).find((a) => a.id === applicationId) || null;
}

function hasApplicationFor(studentId, universityId) {
  return getApplications(studentId).some((a) => a.universityId === universityId);
}

function createApplication(studentId, application) {
  const list = getApplications(studentId);
  const record = {
    id: crypto.randomUUID(),
    studentId,
    ...application,
    createdAt: new Date().toISOString(),
  };
  list.push(record);
  return record;
}

function updateApplication(studentId, applicationId, patch) {
  const list = getApplications(studentId);
  const index = list.findIndex((a) => a.id === applicationId);
  if (index === -1) return null;
  const record = {
    ...list[index],
    ...patch,
    id: applicationId,
    studentId,
    createdAt: list[index].createdAt,
    updatedAt: new Date().toISOString(),
  };
  list[index] = record;
  return record;
}

function deleteApplication(studentId, applicationId) {
  const list = getApplications(studentId);
  const index = list.findIndex((a) => a.id === applicationId);
  if (index === -1) return false;
  list.splice(index, 1);
  return true;
}

module.exports = {
  loadUniversities,
  createStudent,
  getStudent,
  updateStudent,
  getConversation,
  appendMessage,
  getApplications,
  findApplication,
  hasApplicationFor,
  createApplication,
  updateApplication,
  deleteApplication,
};
