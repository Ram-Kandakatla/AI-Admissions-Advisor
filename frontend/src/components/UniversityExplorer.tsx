import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Meta, University } from "../types";

export default function UniversityExplorer({ meta }: { meta: Meta | null }) {
  const [all, setAll] = useState<University[] | null>(null);
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("");
  const [major, setMajor] = useState("");
  const [sort, setSort] = useState<"name" | "acceptance" | "tuition">("name");

  useEffect(() => {
    api.universities().then(setAll).catch(() => setAll([]));
  }, []);

  const rows = useMemo(() => {
    if (!all) return [];
    const q = search.trim().toLowerCase();
    let list = all.filter((u) => {
      if (region && u.region !== region) return false;
      if (major && !u.majors.includes(major)) return false;
      if (q && !`${u.name} ${u.shortName} ${u.city} ${u.state}`.toLowerCase().includes(q)) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      if (sort === "acceptance") return a.acceptanceRate - b.acceptanceRate;
      if (sort === "tuition") return a.tuition - b.tuition;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [all, search, region, major, sort]);

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">The database</span>
        <h2 className="section-title">Browse every school in the set.</h2>
        <p className="lead">
          {all ? `${all.length} universities` : "Loading"} with the numbers that actually matter —
          selectivity, typical stats, and sticker price. Filter and sort to explore.
        </p>
      </div>

      <div className="explorer-controls">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or city…"
          aria-label="Search universities"
        />
        <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Filter by region">
          <option value="">All regions</option>
          {(meta?.regions ?? []).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={major} onChange={(e) => setMajor(e.target.value)} aria-label="Filter by major">
          <option value="">All majors</option>
          {(meta?.majors ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort by">
          <option value="name">Sort: A–Z</option>
          <option value="acceptance">Sort: Most selective</option>
          <option value="tuition">Sort: Lowest tuition</option>
        </select>
        <span className="explorer-count">{rows.length} shown</span>
      </div>

      {!all ? (
        <div className="spinner" aria-label="Loading universities" />
      ) : rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing matches those filters</h3>
          <p>Try clearing the search box or picking a different region or major.</p>
        </div>
      ) : (
        <div className="uni-table-wrap">
          <table className="uni-table">
            <thead>
              <tr>
                <th>University</th>
                <th>Location</th>
                <th>Avg GPA</th>
                <th>Avg SAT</th>
                <th>Admit rate</th>
                <th>Tuition</th>
                <th>Majors</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="name">{u.name}</span>
                  </td>
                  <td>
                    {u.city}, {u.state}
                  </td>
                  <td>{u.avgGPA}</td>
                  <td>{u.avgSAT}</td>
                  <td>{u.acceptanceRate}%</td>
                  <td>${(u.tuition / 1000).toFixed(0)}k</td>
                  <td>{u.majors.slice(0, 3).join(", ")}{u.majors.length > 3 ? "…" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
