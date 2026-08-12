// Major deep-dive: what the dataset can honestly say about one field of study.
//
// IMPORTANT — on what this does NOT do:
// It would be easy to attach prose to each school/major pair ("top-10 robotics
// program", "strong Google recruiting", "join the HCI lab"). We don't, because
// none of that is in the dataset and a student who repeats an invented detail
// in an essay or interview is worse off than one who had nothing. Every number
// below is computed from data/universities.json; everything qualitative is
// either a question for the student to research or a handoff to the chatbot,
// which can answer with its own knowledge and its own caveats.

const { loadUniversities } = require("../store/dataStore");
const { classifyTier } = require("./recommendationEngine");

// Questions worth answering on a school's own admissions/department site.
// Advice about *how* to research a program — deliberately not claims about
// any particular one.
const RESEARCH_QUESTIONS = [
  "Do you apply directly into this major, or declare it after freshman year? Direct-admit programs can be far more selective than the university overall.",
  "What is the intro course sequence, and how large are those first classes?",
  "Can undergraduates join research, and how early do they typically start?",
  "Is there a co-op, internship, or study-abroad track built into the degree?",
  "Which concentrations exist inside the major, and when do you pick one?",
  "What does the career center publish about outcomes for this major specifically?",
  "Which clubs, competitions, or project teams serve this field on campus?",
];

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function spread(values) {
  if (values.length === 0) return null;
  return {
    min: Math.min(...values),
    median: round(median(values), 2),
    max: Math.max(...values),
  };
}

function tally(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function round(n, places = 2) {
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Everything the dataset supports about one major, optionally positioned
 * against a student's profile.
 */
function majorInsights(major, student = null, universities = loadUniversities()) {
  const schools = universities.filter((u) => u.majors.includes(major));

  if (schools.length === 0) {
    return { major, schoolCount: 0, schools: [], offeredBy: null };
  }

  // --- The landscape, straight from the data ---
  const selectivity = spread(schools.map((u) => u.acceptanceRate));
  const tuition = spread(schools.map((u) => u.tuition));
  const avgGPA = spread(schools.map((u) => u.avgGPA));
  const avgSAT = spread(schools.map((u) => u.avgSAT));

  // --- Which other majors travel with this one ---
  // Useful for a student who might switch: a school strong on adjacent fields
  // is one you don't have to transfer out of to change your mind.
  const adjacent = tally(
    schools.flatMap((u) => u.majors.filter((m) => m !== major))
  ).map((entry) => ({
    ...entry,
    // Share of this major's schools that also offer that one.
    share: round(entry.count / schools.length, 3),
  }));

  // --- Position the student against those specific schools ---
  let position = null;
  let combinations = null;

  if (student && typeof student.gpa === "number") {
    const tiers = { reach: 0, target: 0, safety: 0 };
    for (const uni of schools) {
      tiers[classifyTier(uni, round(uni.avgGPA - student.gpa, 2))] += 1;
    }

    const gpas = schools.map((u) => u.avgGPA);
    const medianGPA = median(gpas);

    position = {
      tiers,
      gpa: student.gpa,
      medianGPA: round(medianGPA, 2),
      gpaGapToMedian: round(student.gpa - medianGPA, 2),
      satScore: student.satScore ?? null,
      medianSAT: student.satScore ? median(schools.map((u) => u.avgSAT)) : null,
      // How many of these schools the student could afford at sticker price.
      affordable:
        student.financialNeed === "high"
          ? schools.filter((u) => u.tuition <= 35000).length
          : student.financialNeed === "medium"
          ? schools.filter((u) => u.tuition <= 55000).length
          : schools.length,
    };

    // --- Schools that serve more than one of the student's interests ---
    const others = (student.interestedMajors || []).filter((m) => m !== major);
    combinations = others
      .map((other) => {
        const both = schools.filter((u) => u.majors.includes(other));
        return { major: other, count: both.length, schools: both.map((u) => u.id) };
      })
      .sort((a, b) => b.count - a.count);
  }

  return {
    major,
    schoolCount: schools.length,
    shareOfDataset: round(schools.length / universities.length, 3),
    selectivity,
    tuition,
    avgGPA,
    avgSAT,
    regions: tally(schools.map((u) => u.region)),
    settings: tally(schools.map((u) => u.setting)),
    types: tally(schools.map((u) => u.type)),
    adjacent: adjacent.slice(0, 8),
    position,
    combinations,
    researchQuestions: RESEARCH_QUESTIONS,
    schools: schools
      .map((u) => ({
        id: u.id,
        name: u.name,
        shortName: u.shortName,
        city: u.city,
        state: u.state,
        region: u.region,
        setting: u.setting,
        type: u.type,
        avgGPA: u.avgGPA,
        avgSAT: u.avgSAT,
        acceptanceRate: u.acceptanceRate,
        tuition: u.tuition,
        // Which of the student's *other* intended majors this school also covers.
        alsoCovers: student
          ? (student.interestedMajors || []).filter(
              (m) => m !== major && u.majors.includes(m)
            )
          : [],
        tier:
          student && typeof student.gpa === "number"
            ? classifyTier(u, round(u.avgGPA - student.gpa, 2))
            : null,
      }))
      .sort((a, b) => a.acceptanceRate - b.acceptanceRate),
  };
}

/** Every major in the dataset with how many schools offer it. */
function majorCatalog(universities = loadUniversities()) {
  return tally(universities.flatMap((u) => u.majors)).map(({ key, count }) => ({
    major: key,
    schoolCount: count,
  }));
}

module.exports = { majorInsights, majorCatalog, RESEARCH_QUESTIONS };
