// Synthetic assignments for "Load demo". Due dates are relative to `now` so the demo never goes stale.
// Covers both popup sections and the range edges: past due inside and outside the default 14 days, due within
// hours, days, and more than 30 days out, undated work, and sparse or empty descriptions.
const HOUR = 3600000, DAY = 24 * HOUR;

// Local 11:59 PM `days` from now (negative = past), matching how Canvas deadlines are usually set.
function dueIn(days, now) {
  const date = new Date(now + days * DAY);
  date.setHours(23, 59, 0, 0);
  return date.toISOString();
}

export function demoAssignments(now = Date.now()) {
  const item = (id, course, title, description, dueAt, points, submissionTypes) =>
    ({id: `demo:${id}`, title, course, description, dueAt, points, submissionTypes});
  return [
    // Catch Up
    item('hist-response-5', 'HIST 110 World History', 'Reading response: Chapter 5',
      'Read chapter 5 (pp. 112-140) and write a 300-word response connecting two primary sources to the chapter argument.',
      dueIn(-2, now), 15, ['online_text_entry']),
    item('math-ps-4', 'MATH 267 Linear Algebra', 'Problem set 4: Eigenvalues',
      'Complete problems 5.1 #4, 8, 12 and 5.2 #3, 7, 15, 21. Show all work; scanned handwritten solutions are fine.',
      dueIn(-6, now), 30, ['online_upload']),
    item('bio-lab-3', 'BIO 201 Genetics', 'Lab 3 report: Gel electrophoresis',
      'Write up the gel electrophoresis lab: introduction, methods, results with annotated gel image, and discussion. 4-6 pages.',
      dueIn(-20, now), 50, ['online_upload']),
    // Upcoming: hours to days away
    item('hist-discussion', 'HIST 110 World History', 'Discussion: Industrial Revolution',
      'Post one paragraph answering the prompt, then reply to two classmates.',
      new Date(now + 6 * HOUR).toISOString(), 10, ['discussion_topic']),
    item('cs-review-quiz', 'CS 340 Software Engineering', 'Quiz: Code review practices',
      'Ten multiple choice questions on code review and pull request etiquette. 20 minute time limit.',
      new Date(now + 20 * HOUR).toISOString(), 10, ['online_quiz']),
    item('math-quiz-5', 'MATH 267 Linear Algebra', 'Quiz 5',
      'Covers sections 5.1-5.3.',
      dueIn(2, now), 20, ['online_quiz']),
    item('cs-sprint-2', 'CS 340 Software Engineering', 'Sprint 2: Implement user authentication',
      'Implement login, logout, and password reset for the team project. Include unit tests, update the README, and open a pull request for review.',
      dueIn(3, now), 100, ['online_url']),
    item('capstone-log-6', 'Capstone 1', 'Weekly progress log 6',
      'Submit log.',
      dueIn(4, now), 5, ['online_text_entry']),
    item('bio-ps-genetics', 'BIO 201 Genetics', 'Problem set: Mendelian inheritance',
      'Solve 12 Punnett square and pedigree problems. Problems 9-12 require chi-square tests.',
      dueIn(5, now), 25, ['online_upload']),
    item('eng-essay-draft', 'ENG 102 Composition', 'Argumentative research essay: Full draft',
      'Write a 1500-2000 word argumentative essay with at least five scholarly sources in MLA format. Include an annotated outline as an appendix.',
      dueIn(9, now), 100, ['online_upload']),
    item('eng-peer-review', 'ENG 102 Composition', 'Peer review of two drafts',
      'Use the rubric to give written feedback on two classmates\' drafts.',
      dueIn(12, now), 20, ['online_text_entry']),
    item('hist-primary-source', 'HIST 110 World History', 'Primary source analysis',
      '',
      dueIn(16, now), 40, ['online_upload']),
    // Upcoming: more than 30 days out (hidden when "Due within" is 30 or less)
    item('capstone-design-doc', 'Capstone 1', 'Final design document',
      'Complete system design document: requirements, architecture diagrams, data model, testing plan, and project timeline. Coordinate sections with your team.',
      dueIn(45, now), 200, ['online_upload']),
    item('cs-final-presentation', 'CS 340 Software Engineering', 'Final project presentation',
      'Prepare a 15 minute team demo and slides covering the project architecture and lessons learned.',
      dueIn(60, now), 150, ['on_paper']),
    // Undated
    item('bio-study-guide', 'BIO 201 Genetics', 'Optional: Midterm study guide',
      'Optional practice problems for the midterm. Not graded.',
      null, 0, ['none'])
  ];
}
