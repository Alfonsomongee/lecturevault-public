/**
 * Transcript Refiner — Google Gemini AI Studio Integration
 *
 * Filtra el ruido oral, muletillas, pruebas de audio y charlas intrascendentes.
 * Estructura, organiza y sintetiza el contenido académico útil en Markdown,
 * conservando marcas de tiempo [mm:ss] para poder saltar al audio desde el dashboard.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { GeminiClient } from './GeminiClient.js';
import {
  parseWhisperJson,
  toTimestampedText,
  type TranscriptSegment,
} from '../library/transcript-files.js';

import {
  FACTS_SYSTEM_PROMPT, NOTES_FACTS_RULE, appendMissingFacts, factsBlock, missingFacts, parseFacts, verifyFacts, type Fact,
} from '../study/notes-facts.js';
import {
  NOTES_SYSTEM_PROMPT, batchRanges, buildNotesPrompt, mergeSplitSections, parseDelimitedNotes, rangeTranscript, splitLongRanges, validateNotesOutput,
  type NotesRange, type SectionNotes,
} from '../study/notes-sections.js';

/** Bump when the prompt changes so stored notes can be re-generated on demand (defined with the per-range prompt). */
export { NOTES_PROMPT_VERSION } from '../study/notes-sections.js';

/** ~700k chars ≈ 3 h of Spanish speech; beyond this we refuse rather than truncate silently. */
const MAX_INPUT_CHARS = 700_000;

export interface TranscriptRefinerOptions {
  apiKey?: string;
  model?: string;
  deepseekApiKey?: string;
  deepseekModel?: string;
  logger?: Logger;
  /** Inject a client (tests, shared rate limiting). */
  client?: GeminiClient;
  /** Two passes (list the facts, verify them, then write) instead of one. Default false: one call per batch. */
  facts?: boolean;
}

export interface RefinedTranscriptOutput {
  originalLengthChars: number;
  refinedLengthChars: number;
  cleanText: string;
  cleanTxtPath?: string;
  cleanMdPath?: string;
  modelUsed: string;
  /** True when the notes were generated from timestamped segments */
  timestamped: boolean;
}

export interface SectionNotesResult {
  sections: SectionNotes[];
  /** Ranges the model never wrote, even after the second try */
  failed: number[];
  /** Ranges with no speech: nothing to write */
  silent: number[];
  warnings: string[];
  /** What the calls said when they failed outright (rate limit, cut answer…) */
  errors: string[];
  /** First pass: facts kept after checking them against the transcript, and facts thrown out */
  facts: { kept: number; dropped: number; appended: number };
}

export interface NotesContext {
  title?: string;
  course?: string;
  /** Free-text course glossary to keep spelling of technical terms consistent */
  glossary?: string[];
}

const SYSTEM_PROMPT = `Eres un asistente experto en síntesis académica universitaria y redacción de apuntes técnicos de ingeniería.
Tu objetivo es procesar una transcripción en bruto generada automáticamente por reconocimiento de voz de una clase universitaria y transformarla en un documento de apuntes limpio, riguroso, estructurado y de alto valor para el estudiante.

Instrucciones estrictas:
1. FILTRADO DE RUIDO ORAL:
   - Elimina muletillas ("eh", "este", "bueno", "o sea", "básicamente", "digamos").
   - Elimina repeticiones de palabras, frases cortadas y titubeos.
   - Elimina saludos triviales, comentarios de conexión, comprobaciones de micrófono ("¿se me escucha?", "voy a compartir pantalla", "esperamos a que entren").
   - Elimina pausas y conversaciones intrascendentes que no aporten contenido a la materia.

2. ESTRUCTURA Y ORGANIZACIÓN DEL CONTENIDO:
   Organiza la clase en secciones lógicas y claras utilizando títulos y listas:
   - # [Título de la Clase / Asignatura]
   - ## 1. Resumen Ejecutivo de la Sesión (párrafo sintético con los temas clave tratados)
   - ## 2. Contenido Técnico y Teórico (conceptos explicados, metodologías, herramientas, software como Ansys, Cype, Workbench, métodos de elementos finitos, etc.)
   - ## 3. Criterios de Evaluación y Entregas (desglose exacto de porcentajes de examen final, portafolios, foros, tutorías, software de supervisión como Smowl, plazos y requisitos)
   - ## 4. Preguntas, Dudas y Aclaraciones Importantes (resolución de dudas planteadas por alumnos o advertencias del profesor)
   - ## 5. Conclusiones y Próximos Pasos

3. MARCAS DE TIEMPO:
   - La transcripción incluye marcas [mm:ss] o [h:mm:ss] al inicio de cada bloque.
   - Añade al final de cada título de subsección y de cada viñeta importante la marca del momento en que se explica, con el formato exacto [mm:ss] (o [h:mm:ss] si pasa de una hora). Ejemplo: "### Fase de mallado en Ansys [14:20]".
   - Usa únicamente marcas que existan en la transcripción. No inventes tiempos.

4. RIGOR TÉCNICO:
   - Conserva con total exactitud todos los nombres de software, herramientas, fórmulas, porcentajes y fechas.
   - Escribe las fórmulas en LaTeX entre signos de dólar ($...$ en línea, $$...$$ en bloque).
   - No inventes datos que no aparezcan en la transcripción.
   - Redacta en un tono académico formal, claro, fluido y directo en español.
   - Si una frase es ininteligible o dudosa, omítela en lugar de adivinarla.`;

export class TranscriptRefiner {
  private client: GeminiClient;
  private logger?: Logger;
  private readonly useFacts: boolean;

  constructor(options?: TranscriptRefinerOptions) {
    this.useFacts = options?.facts ?? false;
    this.logger = options?.logger?.child({ component: 'transcript-refiner' });
    this.client =
      options?.client ??
      new GeminiClient({
        apiKey: options?.apiKey,
        model: options?.model,
        deepseekApiKey: options?.deepseekApiKey,
        deepseekModel: options?.deepseekModel,
        logger: options?.logger,
      });
  }

  get model(): string {
    return this.client.model;
  }

  /**
   * Refina y limpia una transcripción en texto con Gemini.
   * `rawText` puede llevar marcas [mm:ss] (recomendado) o ser texto plano.
   */
  public async refineTranscript(rawText: string, context: NotesContext = {}): Promise<string> {
    if (!this.client.hasKey) {
      throw new Error(
        'GEMINI_API_KEY no está configurada. Añádela en tu archivo .env para usar el filtrado inteligente de IA.'
      );
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('La transcripción de entrada está vacía.');
    }

    if (rawText.length > MAX_INPUT_CHARS) {
      throw new Error(
        `La transcripción es demasiado larga (${rawText.length} caracteres; máximo ${MAX_INPUT_CHARS}).`
      );
    }

    const header: string[] = [];
    if (context.course) header.push(`Asignatura: ${context.course}`);
    if (context.title) header.push(`Título de la grabación: ${context.title}`);
    if (context.glossary?.length) {
      header.push(`Vocabulario técnico de la asignatura (usa esta ortografía exacta): ${context.glossary.join(', ')}`);
    }

    this.logger?.info({ model: this.model, inputChars: rawText.length }, 'Enviando transcripción a Gemini AI Studio...');

    const refined = await this.client.generateText(
      `${header.length ? header.join('\n') + '\n\n' : ''}A continuación tienes la transcripción en bruto de la clase. Filtra todo el ruido y devuélveme el documento limpio y perfectamente estructurado:\n\n${rawText}`,
      { system: SYSTEM_PROMPT, temperature: 0.2 }
    );

    this.logger?.info({ outputChars: refined.length }, 'Transcripción refinada recibida de Gemini con éxito');
    return refined;
  }

  /**
   * Notes per range of a class. `ranges` is the whole index of the class; `only` limits which of them
   * get written (default: every range that is not logistics). Ranges go to Gemini in batches; a batch
   * that fails or comes back incomplete is asked once more, and what still fails is reported, not hidden.
   */
  public async refineSections(
    segments: TranscriptSegment[],
    ranges: NotesRange[],
    context: NotesContext = {},
    only?: number[]
  ): Promise<SectionNotesResult> {
    if (!this.client.hasKey) {
      throw new Error('GEMINI_API_KEY no está configurada. Añádela en tu archivo .env para usar el filtrado inteligente de IA.');
    }
    const wanted = new Set(only ?? ranges.map((r) => r.ord));
    const targets = ranges.filter((r) => r.destination !== 'admin' && wanted.has(r.ord));
    const result: SectionNotesResult = { sections: [], failed: [], silent: [], warnings: [], errors: [], facts: { kept: 0, dropped: 0, appended: 0 } };

    const speakingTargets: NotesRange[] = [];
    for (const r of targets) {
      if (rangeTranscript(segments, r).trim()) speakingTargets.push(r);
      else result.silent.push(r.ord);
    }
    // A range too long for one answer is written in parts and put back together at the end
    const { units: speaking, parts } = splitLongRanges(speakingTargets, segments);
    const transcripts = new Map(speaking.map((u) => [u.ord, rangeTranscript(segments, u)] as const));
    // The class index the model sees lists the parts of a split range, not the whole range
    const index = ranges.flatMap((r) => (parts.has(r.ord) ? speaking.filter((u) => parts.get(r.ord)!.includes(u.ord)) : [r]));
    const writtenUnits: SectionNotes[] = [];

    // Each part of a split range goes in its own call: two parts together would ask for as much text back as the
    // answer limit that made the range too long in the first place
    const partOrds = new Set([...parts.values()].filter((p) => p.length > 1).flat());
    const size = (r: NotesRange): number => transcripts.get(r.ord)!.length;
    const batches = [
      ...batchRanges(speaking.filter((u) => !partOrds.has(u.ord)), size),
      ...speaking.filter((u) => partOrds.has(u.ord)).map((u) => [u]),
    ];

    for (const batch of batches) {
      let pending = batch;
      const items = (list: NotesRange[]) => list.map((range) => ({ range, transcript: transcripts.get(range.ord)! }));

      // First pass: what is worth keeping, checked against the transcript. If it fails, the notes are
      // still written in one pass, as before.
      const facts = new Map<number, Fact[]>();
      if (this.useFacts) {
        try {
          const answer = await this.client.generateText(buildNotesPrompt(items(batch), index, context), {
            system: FACTS_SYSTEM_PROMPT, temperature: 0.1,
          });
          const listed = parseFacts(answer);
          for (const range of batch) {
            const { kept, dropped } = verifyFacts(listed.get(range.ord) ?? [], range, segments);
            result.facts.kept += kept.length;
            result.facts.dropped += dropped.length;
            if (kept.length > 0) facts.set(range.ord, kept);
            if (dropped.length > 0) result.warnings.push(`«${range.heading}»: ${dropped.length} hecho(s) descartados (${dropped.slice(0, 2).join('; ')})`);
          }
        } catch (err) {
          this.logger?.warn({ err: (err as Error).message }, 'Fallo la extracción de hechos; se escriben los apuntes en un solo paso');
          result.warnings.push('No se pudieron extraer los hechos de la clase: apuntes escritos en un solo paso');
        }
      }
      const extras = new Map([...facts].map(([ord, list]) => [ord, factsBlock(list)] as const));

      for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
        try {
          const answer = await this.client.generateText(buildNotesPrompt(items(pending), index, context, extras), {
            system: facts.size > 0 ? NOTES_SYSTEM_PROMPT + NOTES_FACTS_RULE : NOTES_SYSTEM_PROMPT, temperature: 0.2,
          });
          const model = this.client.lastModelUsed;
          const checked = validateNotesOutput(parseDelimitedNotes(answer, pending.map((r) => r.ord)), pending, segments);
          writtenUnits.push(...checked.sections.map((section) => {
            // What the first pass found and the notes left out goes at the end of the range, with its minute
            const gaps = missingFacts(facts.get(section.ord) ?? [], section.markdown);
            result.facts.appended += gaps.length;
            return { ...section, markdown: appendMissingFacts(section.markdown, gaps), model };
          }));
          result.warnings.push(...checked.warnings);
          pending = pending.filter((r) => checked.failed.includes(r.ord));
        } catch (err) {
          this.logger?.warn({ err: (err as Error).message, attempt, ranges: pending.map((r) => r.ord) }, 'Fallo al escribir los apuntes de una tanda');
          if (attempt === 2) result.errors.push((err as Error).message);
        }
      }
      for (const r of pending) {
        result.warnings.push(`No se pudieron escribir los apuntes de «${r.heading}»`);
      }
    }
    const merged = mergeSplitSections(writtenUnits, parts);
    result.sections = merged.sections;
    result.failed = merged.failed;
    this.logger?.info(
      { written: result.sections.length, failed: result.failed.length, silent: result.silent.length },
      'Apuntes por tramo generados'
    );
    return result;
  }

  /** Genera apuntes a partir de segmentos con tiempo (lo que produce faster-whisper). */
  public async refineSegments(segments: TranscriptSegment[], context: NotesContext = {}): Promise<string> {
    return this.refineTranscript(toTimestampedText(segments), context);
  }

  /**
   * Refina el archivo de transcripción (.txt) y guarda las versiones .clean.txt y .clean.md.
   * Si existe el .json hermano, usa los segmentos con marcas de tiempo.
   */
  public async refineTranscriptFile(txtFilePath: string, context: NotesContext = {}): Promise<RefinedTranscriptOutput> {
    const resolvedPath = path.resolve(txtFilePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`El archivo de transcripción no existe: "${resolvedPath}"`);
    }

    const rawContent = fs.readFileSync(resolvedPath, 'utf8');
    const dir = path.dirname(resolvedPath);
    const baseName = path.basename(resolvedPath, path.extname(resolvedPath));

    let input = rawContent;
    let timestamped = false;
    const jsonPath = path.join(dir, `${baseName}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        const stamped = toTimestampedText(parseWhisperJson(fs.readFileSync(jsonPath, 'utf8')).segments);
        if (stamped.trim()) {
          input = stamped;
          timestamped = true;
        }
      } catch (err) {
        this.logger?.warn({ err }, 'No se pudo leer el JSON de segmentos; se usa el texto plano sin marcas de tiempo');
      }
    }

    const cleanContent = await this.refineTranscript(input, context);

    const cleanTxtPath = path.join(dir, `${baseName}.clean.txt`);
    const cleanMdPath = path.join(dir, `${baseName}.clean.md`);

    fs.writeFileSync(cleanTxtPath, cleanContent, 'utf8');
    fs.writeFileSync(cleanMdPath, cleanContent, 'utf8');

    return {
      originalLengthChars: rawContent.length,
      refinedLengthChars: cleanContent.length,
      cleanText: cleanContent,
      cleanTxtPath,
      cleanMdPath,
      modelUsed: this.client.lastModelUsed,
      timestamped,
    };
  }
}
