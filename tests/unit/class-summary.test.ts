import { describe, expect, it } from 'vitest';
import {
  MIN_BODY_CHARS, buildSummaryPrompt, hasKeyPoints, notesBody, pointTarget, polishGist, renderSummary, stripSummary,
  summarizeNotes, summaryInput, validateSummary, withSummary, type SummaryClient,
} from '../../src/study/class-summary.js';
import { extractSummary } from '../../src/study/notes-summary.js';

const BODY = `## Máquina y mecanismo [11:40]

### Definición de máquina [11:50]
- Una máquina transforma energía y realiza un trabajo útil [12:10].
- Un mecanismo transmite o transforma el movimiento sin buscar un trabajo útil [12:40].
- La diferencia práctica: la máquina consume potencia, el mecanismo solo guía el movimiento [13:05].

### Pares cinemáticos [14:00]
- Un par cinemático es la unión móvil entre dos eslabones [14:20].
- El par inferior tiene contacto de superficie y el par superior contacto de línea o de punto [15:05].
- Los pares inferiores más usados son el de revolución y el prismático [16:30].

### Grados de libertad [18:30]
- Fórmula de Grübler: $F = 3(n-1) - 2 j_1 - j_2$ [19:10].
- Un mecanismo de cuatro barras tiene 1 grado de libertad con 4 eslabones y 4 pares [20:45].
- Si F vale 0 la estructura es rígida y si F es negativo está sobrerrestringida [22:10].

> [!EXAM] Entra en el examen
> El profesor insiste en que la fórmula de Grübler cae en el examen [23:00].

### Ley de Grashof [25:00]
- En un cuadrilátero articulado, la suma del eslabón más corto y el más largo debe ser menor o igual que la suma de los otros dos para que exista un eslabón que gire completo [25:40].
- El eslabón más corto fijo da un mecanismo de doble manivela, y adyacente al fijo da manivela-balancín [27:15].
`;

const GOOD = `<<<RESUMEN>>>
La clase distingue máquina y mecanismo, define el par cinemático y calcula los grados de libertad con la fórmula de Grübler, aplicada al cuadrilátero de cuatro barras. Termina con la ley de Grashof, que decide qué eslabón puede girar completo. El profesor avisa de que la fórmula de Grübler entra en el examen.
<<<PUNTOS>>>
- Una máquina transforma energía y consume potencia; un mecanismo solo guía el movimiento [12:10]
- Un par cinemático es la unión móvil entre dos eslabones; puede ser inferior (superficie) o superior (línea o punto) [14:20]
- Grübler: $F = 3(n-1) - 2 j_1 - j_2$; el cuadrilátero de cuatro barras tiene 1 grado de libertad [19:10]
- Con F = 0 la estructura es rígida y con F negativo está sobrerrestringida [22:10]
- Ley de Grashof: la suma del eslabón más corto y el más largo no debe superar la de los otros dos [25:40]
<<<FIN>>>`;

describe('editing the notes document', () => {
  const DOC = `# Clase 3. Mecanismos\n\n## Resumen\n\nResumen viejo.\n\n## Puntos clave\n\n- Viejo punto\n\n## Máquina y mecanismo [11:40]\n\n${BODY.split('\n').slice(2).join('\n')}`;

  it('removes the summary blocks and keeps everything else', () => {
    const stripped = stripSummary(DOC);
    expect(stripped).not.toContain('Resumen viejo');
    expect(stripped).not.toContain('Viejo punto');
    expect(stripped).toContain('# Clase 3. Mecanismos');
    expect(stripped).toContain('## Máquina y mecanismo [11:40]');
  });

  it('ignores a "## Resumen" inside a code fence', () => {
    const md = '# T\n\n## Sección\n\n```\n## Resumen\nno es un título\n```\n\ntexto\n';
    expect(stripSummary(md)).toContain('no es un título');
  });

  it('the body is what the summary is written from: no title, no earlier summary', () => {
    const body = notesBody(DOC);
    expect(body.startsWith('## Máquina y mecanismo')).toBe(true);
    expect(body).not.toContain('Resumen viejo');
    expect(body).not.toContain('# Clase 3');
  });

  it('puts the new summary under the title, replacing the old one, and leaves the sections as they were', () => {
    const next = withSummary(DOC, { text: 'Párrafo nuevo.', points: ['Punto uno [12:10]', 'Punto dos'] });
    expect(next.indexOf('# Clase 3. Mecanismos')).toBe(0);
    expect(next).toContain('## Resumen\n\nPárrafo nuevo.\n\n## Puntos clave\n\n- Punto uno [12:10]\n- Punto dos\n\n## Máquina y mecanismo [11:40]');
    expect(next).not.toContain('Resumen viejo');
    expect(notesBody(next)).toBe(notesBody(DOC));
    expect(hasKeyPoints(next)).toBe(true);
    expect(hasKeyPoints(DOC)).toBe(true);
    expect(hasKeyPoints(stripSummary(DOC))).toBe(false);
    // applying it twice changes nothing
    expect(withSummary(next, { text: 'Párrafo nuevo.', points: ['Punto uno [12:10]', 'Punto dos'] })).toBe(next);
  });

  it('adds the summary to a document without a title, and views read only the paragraph', () => {
    const next = withSummary('## Sección\n\ntexto largo '.repeat(3), { text: 'Solo párrafo.', points: ['a b c d e f g h i j k l'] });
    expect(next.startsWith('## Resumen\n\nSolo párrafo.')).toBe(true);
    expect(extractSummary(withSummary(DOC, { text: 'Un párrafo de resumen.', points: ['Punto uno de la clase [1:00]'] }))).toBe('Un párrafo de resumen.');
  });

  it('renders no key-point section without points', () => {
    expect(renderSummary({ text: 'X', points: [] })).toBe('## Resumen\n\nX');
  });
});

describe('polishGist (the fallback summary)', () => {
  it('drops the pipeline word that leaked into the text', () => {
    expect(polishGist('Este tramo describe la organización del aula.')).toBe('Describe la organización del aula.');
    expect(polishGist('El tramo de la clase repasa los pares cinemáticos.')).toBe('Repasa los pares cinemáticos.');
    expect(polishGist('Anuncio de que la próxima sesión será práctica.')).toBe('Anuncio de que la próxima sesión será práctica.');
    expect(polishGist('  ')).toBe('');
  });
});

describe('prompt input', () => {
  it('a class asks for more key points the more there is to say, between 5 and 10', () => {
    expect(pointTarget(900)).toBe(5);
    expect(pointTarget(20_000)).toBe(5);
    expect(pointTarget(30_000)).toBe(8);
    expect(pointTarget(200_000)).toBe(10);
  });

  it('sends the notes whole when they fit and cuts every section in proportion when they do not', () => {
    expect(summaryInput(BODY)).toBe(BODY);
    const big = [0, 1, 2].map((i) => `## Sección ${i} [0${i}:00]\n${`- punto largo de la sección ${i} con bastante texto\n`.repeat(400)}`).join('');
    const cut = summaryInput(big, 9_000);
    expect(cut.length).toBeLessThan(big.length / 2);
    for (const i of [0, 1, 2]) expect(cut).toContain(`## Sección ${i}`);
    expect(cut).toContain('[…]');
  });

  it('puts the asked number of points and the notes in the prompt', () => {
    const prompt = buildSummaryPrompt(BODY, { title: 'Clase 3', course: '02MUIN' }, 6);
    expect(prompt).toContain('Asignatura: 02MUIN');
    expect(prompt).toContain('entre 5 y 6');
    expect(prompt).toContain('### Pares cinemáticos [14:00]');
  });
});

describe('validateSummary', () => {
  it('accepts a good answer', () => {
    const check = validateSummary(GOOD, BODY);
    expect(check.problems).toEqual([]);
    expect(check.summary!.points).toHaveLength(5);
    expect(check.summary!.text).toMatch(/^La clase distingue máquina y mecanismo/);
    expect(check.summary!.points[2]).toContain('[19:10]');
    expect(check.warnings).toEqual([]);
  });

  it('accepts an answer wrapped in a code fence', () => {
    expect(validateSummary(`\`\`\`\n${GOOD}\n\`\`\``, BODY).summary).toBeDefined();
  });

  it('asks again when the format is wrong', () => {
    const check = validateSummary('Aquí tienes el resumen: la clase trata de mecanismos.', BODY);
    expect(check.summary).toBeUndefined();
    expect(check.problems[0]).toMatch(/Formato/);
  });

  it('rejects a paragraph that uses the pipeline word «tramo»', () => {
    const answer = GOOD.replace('La clase distingue', 'Este tramo distingue');
    expect(validateSummary(answer, BODY).problems.join(' ')).toMatch(/tramo/);
  });

  it('allows «tramo» when the notes use it for something real', () => {
    const body = `${BODY}\n- Un tramo de viga trabaja a flexión [30:00].`;
    expect(validateSummary(GOOD.replace('La clase distingue', 'Este tramo de viga y la clase distinguen'), body).problems).toEqual([]);
  });

  it('rejects a paragraph with a figure the notes never say', () => {
    const answer = GOOD.replace('aplicada al cuadrilátero', 'con un 73,4 % de acierto, aplicada al cuadrilátero');
    const check = validateSummary(answer, BODY);
    expect(check.summary).toBeUndefined();
    expect(check.problems.join(' ')).toMatch(/73\.4/);
  });

  it('checks dates in words, even a one-digit day that the number check lets through', () => {
    const withDate = GOOD.replace('El profesor avisa', 'La Actividad 1 se entrega el lunes 9. El profesor avisa');
    const bad = validateSummary(withDate, BODY);
    expect(bad.summary).toBeUndefined();
    expect(bad.problems.join(' ')).toMatch(/fechas.*lunes 9/);
    // the same sentence is fine when the notes say it
    expect(validateSummary(withDate, `${BODY}\n- La Actividad 1 se entrega el lunes 9 [30:00].\n`).problems).toEqual([]);
    // and a key point with an invented date is dropped on its own
    const point = validateSummary(GOOD.replace('<<<FIN>>>', '- El proyecto se presenta el 9 de noviembre en clase [27:15]\n<<<FIN>>>'), BODY);
    expect(point.summary!.points).toHaveLength(5);
    expect(point.warnings.join(' ')).toMatch(/fecha/);
  });

  it('writes the key points as a list: no full stop at the end, before the mark or without it', () => {
    const answer = GOOD
      .replace('consume potencia; un mecanismo solo guía el movimiento [12:10]', 'consume potencia; un mecanismo solo guía el movimiento. [12:10]')
      .replace('sobrerrestringida [22:10]', 'sobrerrestringida.');
    const points = validateSummary(answer, BODY).summary!.points;
    expect(points[0]).toMatch(/el movimiento \[12:10\]$/);
    expect(points[3]).toMatch(/sobrerrestringida$/);
  });

  it('rejects a paragraph that is too short or too long', () => {
    expect(validateSummary(GOOD.replace(/<<<RESUMEN>>>[\s\S]*?<<<PUNTOS>>>/, '<<<RESUMEN>>>\nMecanismos.\n<<<PUNTOS>>>'), BODY).problems.join(' ')).toMatch(/corto/);
    expect(validateSummary(GOOD.replace(/<<<RESUMEN>>>[\s\S]*?<<<PUNTOS>>>/, `<<<RESUMEN>>>\n${'Frase de relleno. '.repeat(80)}\n<<<PUNTOS>>>`), BODY).problems.join(' ')).toMatch(/largo/);
  });

  it('drops a key point with an invented figure on its own and keeps the rest', () => {
    const answer = GOOD.replace('<<<FIN>>>', '- La tolerancia habitual es de 0,05 mm en todos los pares [16:30]\n<<<FIN>>>');
    const check = validateSummary(answer, BODY);
    expect(check.summary!.points).toHaveLength(5);
    expect(check.warnings.join(' ')).toMatch(/cifras/);
  });

  it('removes a time mark the notes do not have but keeps the point', () => {
    const answer = GOOD.replace('[12:10]', '[59:59]');
    const point = validateSummary(answer, BODY).summary!.points[0]!;
    expect(point).not.toContain('59:59');
    expect(point).toMatch(/^Una máquina transforma energía/);
  });

  it('accepts a mark within two seconds of one in the notes', () => {
    expect(validateSummary(GOOD.replace('[12:10]', '[12:11]'), BODY).summary!.points[0]).toContain('[12:11]');
  });

  it('drops points that repeat each other and points that are too short or too long', () => {
    const answer = GOOD.replace('<<<FIN>>>', [
      '- Un par cinemático es la unión móvil entre dos eslabones y puede ser inferior o superior [14:20]',
      '- Corto',
      `- ${'Punto larguísimo '.repeat(30)}`,
      '<<<FIN>>>',
    ].join('\n'));
    const check = validateSummary(answer, BODY);
    expect(check.summary!.points).toHaveLength(5);
    expect(check.warnings.length).toBe(3);
  });

  it('needs at least three valid points', () => {
    const answer = GOOD.split('\n').filter((l) => !/^- (Con F|Ley de Grashof|Grübler)/.test(l)).join('\n');
    const check = validateSummary(answer, BODY);
    expect(check.summary).toBeUndefined();
    expect(check.problems.join(' ')).toMatch(/puntos clave válidos/);
  });

  it('joins a point the model wrapped over two lines and caps the list', () => {
    const topics = [
      'engranajes rectos transmiten potencia entre ejes paralelos', 'leva seguidor convierte rotación continua en vaivén',
      'volante inercia regula fluctuaciones velocidad ciclo', 'resorte almacena energía elástica proporcional deformación',
      'rodamiento reduce rozamiento ejes giratorios cargas', 'tornillo sinfín reduce velocidad aumenta par',
      'junta cardan transmite giro entre ejes concurrentes', 'freno disipa energía cinética calor fricción',
      'embrague acopla desacopla árbol motor transmisión', 'biela manivela convierte alternativo en rotativo',
      'trinquete permite giro único sentido bloqueando', 'correa dentada sincroniza ejes distancia grande',
      'cadena rodillos transmite potencia sin deslizamiento', 'cojinete deslizante soporta cargas lubricación hidrodinámica',
    ];
    const many = topics.map((t) => `- El ${t}`).join('\n');
    const check = validateSummary(GOOD.replace(/<<<PUNTOS>>>[\s\S]*<<<FIN>>>/, `<<<PUNTOS>>>\n${many}\n<<<FIN>>>`), BODY, 8);
    expect(check.summary!.points.length).toBeLessThanOrEqual(8);
    const wrapped = validateSummary(GOOD.replace('- Con F = 0 la estructura es rígida', '- Con F = 0 la estructura\n  es rígida'), BODY);
    expect(wrapped.summary!.points.some((p) => p.includes('estructura es rígida'))).toBe(true);
  });
});

describe('summarizeNotes', () => {
  const client = (answers: (string | Error)[]) => {
    const prompts: string[] = [];
    const c: SummaryClient = {
      async generateText(prompt) {
        prompts.push(prompt);
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next ?? '';
      },
    };
    return { c, prompts };
  };

  it('does not call the model for notes too short to summarise', async () => {
    const { c, prompts } = client([GOOD]);
    expect(await summarizeNotes(c, 'x'.repeat(MIN_BODY_CHARS - 1))).toEqual({ warnings: [] });
    expect(prompts).toHaveLength(0);
  });

  it('returns the summary of a good first answer', async () => {
    const { c, prompts } = client([GOOD]);
    const out = await summarizeNotes(c, BODY, { title: 'Clase 3' });
    expect(out.summary!.points).toHaveLength(5);
    expect(prompts).toHaveLength(1);
  });

  it('asks again telling the model what was wrong, and uses the second answer', async () => {
    const { c, prompts } = client([GOOD.replace('La clase distingue', 'Este tramo distingue'), GOOD]);
    const out = await summarizeNotes(c, BODY);
    expect(out.summary).toBeDefined();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Tu intento anterior tenía estos problemas');
    expect(prompts[1]).toContain('tramo');
  });

  it('gives up after two bad answers and says why, so the old summary stays', async () => {
    const { c } = client(['nada útil', 'tampoco']);
    const out = await summarizeNotes(c, BODY);
    expect(out.summary).toBeUndefined();
    expect(out.warnings.join(' ')).toMatch(/resumen por partes/);
  });

  it('survives a model that throws', async () => {
    const { c } = client([new Error('429 cuota'), new Error('503')]);
    const out = await summarizeNotes(c, BODY);
    expect(out.summary).toBeUndefined();
    expect(out.warnings.join(' ')).toMatch(/503/);
  });
});
