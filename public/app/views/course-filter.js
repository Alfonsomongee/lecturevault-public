// The course filter shared by Clases, Repaso, Preguntar and Buscar: opening a course in the sidebar sets it,
// so every view it affects has to show it and offer a way out.
import { html, NO_COURSE } from '../util.js';
import { state, setCourse } from '../main.js';

export function courseFilter(id = 'course-filter') {
  const courses = [...new Set([...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter(Boolean)])];
  return html`<label class="sr-only" for="${id}">Asignatura</label>
    <select class="input" id="${id}" data-course-filter>
      <option value="">Todas las asignaturas</option>
      ${courses.map((c) => html`<option value="${c}" ${c === state.course ? html`selected` : ''}>${c}</option>`)}
      <option value="${NO_COURSE}" ${state.course === NO_COURSE ? html`selected` : ''}>Sin asignatura</option>
    </select>`;
}

export function bindCourseFilter(root) {
  root.querySelector('[data-course-filter]')?.addEventListener('change', (e) => setCourse(e.target.value));
}
