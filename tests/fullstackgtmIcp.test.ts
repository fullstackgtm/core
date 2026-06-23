import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FIT_THRESHOLD,
  fitThreshold,
  icpFromAnswers,
  icpToCrustdataFilters,
  icpToExploriumFilters,
  parseIcp,
  scoreProspectAgainstIcp,
  type Icp,
} from "../src/icp.ts";

const ICP: Icp = {
  name: "FSGTM RevOps ICP",
  firmographics: { industries: ["software", "saas"], employeeBands: ["1-10", "51-200"], geos: ["us"], naics: ["5112"] },
  persona: {
    jobLevels: ["vp", "director", "manager", "cxo"],
    departments: ["sales", "operations"],
    titleKeywords: ["revenue operations", "sales operations", "cro"],
  },
  scoring: { threshold: 0.5 },
};

test("parseIcp validates name + persona", () => {
  assert.equal(parseIcp(JSON.stringify(ICP)).name, "FSGTM RevOps ICP");
  assert.throws(() => parseIcp(JSON.stringify({ firmographics: {}, persona: { titleKeywords: ["x"] } })), /missing "name"/);
  assert.throws(() => parseIcp(JSON.stringify({ name: "x", persona: {} })), /persona/);
});

test("icpToExploriumFilters maps firmographics + persona to Explorium's shape", () => {
  const f = icpToExploriumFilters(ICP);
  assert.deepEqual(f.has_email, { value: true });
  assert.deepEqual(f.job_level, { values: ["vp", "director", "manager", "cxo"] });
  assert.deepEqual(f.company_size, { values: ["1-10", "51-200"] });
  assert.deepEqual(f.company_country_code, { values: ["us"] });
  assert.deepEqual(f.naics_category, { values: ["5112"] });
});

test("icpToCrustdataFilters Title-Cases titles, maps geo, seniority + industry vocab", () => {
  const f = icpToCrustdataFilters(ICP) as {
    current_job_titles: string[];
    locations: string[];
    current_seniority_levels: { include: string[]; exclude: string[] };
    current_employers_linkedin_industries: string[];
  };
  assert.deepEqual(f.current_job_titles, ["Revenue Operations", "Sales Operations", "CRO"]);
  assert.deepEqual(f.locations, ["United States"]);
  // jobLevels ["vp","director","manager","cxo"] → Crustdata vocab
  assert.deepEqual(f.current_seniority_levels.include, ["Vice President", "Director", "Manager", "CXO"]);
  // industries ["software","saas"] → LinkedIn industry cluster (deduped)
  assert.deepEqual(f.current_employers_linkedin_industries, [
    "Software Development",
    "Information Technology and Services",
    "Internet",
  ]);
});

test("scoreProspectAgainstIcp: title match clears threshold; off-persona does not", () => {
  const onIcp = scoreProspectAgainstIcp(
    { jobTitle: "Director, Revenue Operations", jobLevel: "director", jobDepartment: "operations" },
    ICP,
  );
  assert.ok(onIcp.score >= fitThreshold(ICP), `expected fit >= threshold, got ${onIcp.score}`);
  assert.ok(onIcp.reasons.some((r) => /keyword/.test(r)));

  const offIcp = scoreProspectAgainstIcp({ jobTitle: "Software Engineer", jobLevel: "senior", jobDepartment: "engineering" }, ICP);
  assert.ok(offIcp.score < fitThreshold(ICP), `expected fit < threshold, got ${offIcp.score}`);
});

test("scoreProspectAgainstIcp: matches the keyword in the headline when the formal title misses", () => {
  // LinkedIn-sourced: position is generic, but the headline carries the role.
  const viaHeadline = scoreProspectAgainstIcp(
    { jobTitle: "Founder & Managing Partner", headline: "Fractional RevOps Architect | Revenue Operations", jobLevel: "owner" },
    ICP,
  );
  assert.ok(viaHeadline.score >= fitThreshold(ICP), `expected headline match to clear threshold, got ${viaHeadline.score}`);
  assert.ok(viaHeadline.reasons.some((r) => /keyword/.test(r)));

  // No keyword in title OR headline → still below threshold (no false positive).
  const neither = scoreProspectAgainstIcp({ jobTitle: "Founder", headline: "Building cool things" }, ICP);
  assert.ok(neither.score < fitThreshold(ICP), `expected no-match below threshold, got ${neither.score}`);
});

test("icpFromAnswers assembles an ICP and infers levels from titles", () => {
  const icp = icpFromAnswers("Test", {
    industries: ["software", "saas"],
    employeeBands: ["1-10", "11-50"],
    titleKeywords: ["chief revenue officer", "revenue operations"],
    geos: ["us"],
    jobLevels: [],
    departments: [],
  });
  assert.equal(icp.name, "Test");
  assert.deepEqual(icp.firmographics.geos, ["us"]);
  assert.ok(icp.persona.jobLevels?.includes("cxo")); // inferred from "chief revenue officer"
  assert.ok(icp.firmographics.naics?.includes("5112")); // software → naics
  assert.equal(fitThreshold(icp), DEFAULT_FIT_THRESHOLD);
});
