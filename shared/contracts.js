export function validateAssignments(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Expected at most 100 assignments');
  const seen = new Set();
  return value.map(a => {
    if (!a || typeof a.id !== 'string' || !a.id || a.id.length > 300 || seen.has(a.id)) throw new Error('Assignment IDs must be unique strings');
    seen.add(a.id);
    for (const key of ['title','course','description']) {
      if (typeof a[key] !== 'string' || a[key].length > (key === 'description' ? 12000 : 500)) throw new Error(`Invalid ${key}`);
    }
    if (a.dueAt !== null && (typeof a.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(a.dueAt) || !Number.isFinite(Date.parse(a.dueAt)))) throw new Error('Invalid dueAt: use ISO timestamp or null');
    if (!Number.isFinite(a.points) || a.points < 0 || !Array.isArray(a.submissionTypes) || a.submissionTypes.some(s => typeof s !== 'string' || s.length > 100)) throw new Error('Invalid assignment metadata');
    return {id:a.id,title:a.title,course:a.course,description:a.description,dueAt:a.dueAt,points:a.points,submissionTypes:a.submissionTypes};
  });
}
export function validateEstimate(value) {
  if (!value || !Number.isInteger(value.estimatedMinutes) || value.estimatedMinutes < 5 || value.estimatedMinutes > 10080 || typeof value.reason !== 'string' || !value.reason || value.reason.length > 1000) throw new Error('Invalid model output');
  return {estimatedMinutes:value.estimatedMinutes,reason:value.reason};
}
export function plan(assignment, estimate, provider) {
  return {...assignment,...estimate,provider,startAt:assignment.dueAt ? new Date(Date.parse(assignment.dueAt) - Math.ceil(estimate.estimatedMinutes * 1.25) * 60000).toISOString() : null};
}
