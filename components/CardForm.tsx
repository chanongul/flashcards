'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type FieldType, type NoteType } from '@/lib/db';
import { clozeBlankLetters, buildClozeText, parseClozeToDraft } from '@/lib/cloze';
import {
  FieldTypeToggle,
  FieldValueInput,
  inferFieldType,
  fieldHasContent,
  fieldNeedsLabel,
  reconcileFieldValues,
} from './MediaFieldInput';
import { resolvePendingMediaInHtml } from '@/lib/mediaSync';
import { useLoading } from './GlobalLoading';
import { Checkbox } from './Checkbox';
import { ClozeEditor } from './ClozeEditor';
import { TagsInput } from './TagsInput';

interface CardFormProps {
  mode: 'create' | 'edit';
  initialCardType?: 'basic' | 'cloze' | string;
  initialFront?: string;
  initialBack?: string;
  initialFields?: Record<string, string>;
  initialTags?: string[];
  initialReversed?: boolean;
  onSubmit: (data: {
    cardType: 'basic' | 'cloze' | string;
    front: string;
    back: string;
    fields: Record<string, string>;
    tags: string[];
    reversed: boolean;
  }) => void | Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export function CardForm({
  mode,
  initialCardType = 'basic',
  initialFront = '',
  initialBack = '',
  initialFields = {},
  initialTags = [],
  initialReversed = false,
  onSubmit,
  onCancel,
  submitLabel,
}: CardFormProps) {
  const { withLoading } = useLoading();
  const noteTypes = useLiveQuery(() => db.noteTypes.filter((nt) => !nt.deleted).toArray(), []);

  const [cardType, setCardType] = useState<'basic' | 'cloze' | string>(initialCardType);
  const [front, setFront] = useState(initialFront);
  const [back, setBack] = useState(initialBack);
  const [frontType, setFrontType] = useState<FieldType>('richtext');
  const [backType, setBackType] = useState<FieldType>('richtext');

  const [clozeText, setClozeText] = useState('');
  const [clozeAnswers, setClozeAnswers] = useState<Record<string, string>>({});
  const [clozeSeparateCards, setClozeSeparateCards] = useState(false);

  const [fieldValues, setFieldValues] = useState<Record<string, string>>(initialFields);
  const [dynamicFieldTypes, setDynamicFieldTypes] = useState<Record<string, FieldType>>({});
  const [tagsInput, setTagsInput] = useState<string[]>(initialTags);
  const [editReversed, setEditReversed] = useState(initialReversed);
  const [error, setError] = useState('');

  const selectedNoteType = useMemo(() => {
    if (cardType === 'basic' || cardType === 'cloze') return undefined;
    return noteTypes?.find((nt) => nt.id === cardType);
  }, [cardType, noteTypes]);

  function resolvedFieldType(fieldName: string): FieldType {
    const config = selectedNoteType?.fieldTypes?.[fieldName] ?? 'richtext';
    if (config === 'dynamic') return dynamicFieldTypes[fieldName] ?? 'richtext';
    return config;
  }

  // Setup form states when editing
  useEffect(() => {
    if (mode === 'edit') {
      setCardType(initialCardType);
      setFront(initialFront);
      setBack(initialBack);
      setFrontType(inferFieldType(initialFront));
      setBackType(inferFieldType(initialBack));

      const draft = parseClozeToDraft(initialFront);
      setClozeText(draft.template);
      setClozeAnswers(draft.answers);
      setClozeSeparateCards(draft.separateCards);

      setTagsInput(initialTags);
      setEditReversed(initialReversed);
    }
  }, [mode, initialCardType, initialFront, initialBack, initialTags, initialReversed]);

  useEffect(() => {
    if (mode === 'edit' && selectedNoteType) {
      const reconciled = reconcileFieldValues(initialFields, selectedNoteType);
      setFieldValues(reconciled);
      const dynTypes: Record<string, FieldType> = {};
      for (const f of selectedNoteType.fields) {
        if ((selectedNoteType.fieldTypes?.[f] ?? 'richtext') === 'dynamic') {
          dynTypes[f] = inferFieldType(reconciled[f] ?? '');
        }
      }
      setDynamicFieldTypes(dynTypes);
    }
  }, [mode, selectedNoteType, initialFields]);

  function selectCardType(type: 'basic' | 'cloze' | string) {
    setCardType(type);
    setFront('');
    setBack('');
    setFrontType('richtext');
    setBackType('richtext');
    setEditReversed(false);
    setClozeText('');
    setClozeAnswers({});
    setClozeSeparateCards(false);
    setFieldValues({});
    setDynamicFieldTypes({});
    setTagsInput([]);
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (selectedNoteType) {
      const isFilled = (f: string) =>
        fieldHasContent(fieldValues[f] ?? '', resolvedFieldType(f));
      const missingLabelField = selectedNoteType.fields.find((f) =>
        fieldNeedsLabel(fieldValues[f] ?? '', resolvedFieldType(f))
      );
      if (missingLabelField) {
        setError(`Add a label for "${missingLabelField}" (used for search).`);
        return;
      }
      if (!selectedNoteType.questionFields.some(isFilled)) {
        setError('Fill in at least one question field.');
        return;
      }
      if (!selectedNoteType.answerFields.some(isFilled)) {
        setError('Fill in at least one answer field.');
        return;
      }

      await withLoading(async () => {
        const resolvedFields = Object.fromEntries(
          await Promise.all(
            Object.entries(fieldValues).map(async ([key, val]) => [
              key,
              await resolvePendingMediaInHtml(val),
            ])
          )
        );
        await onSubmit({
          cardType,
          front: '',
          back: '',
          fields: resolvedFields,
          tags: tagsInput,
          reversed: editReversed,
        });
      });
    } else if (cardType === 'cloze') {
      if (!clozeText.trim()) {
        setError('Enter the cloze text.');
        return;
      }
      const letters = clozeBlankLetters(clozeText);
      if (letters.length === 0) {
        setError('Click + to mark at least one blank.');
        return;
      }
      if (letters.some((letter) => !clozeAnswers[letter]?.trim())) {
        setError('Fill in an answer for every blank.');
        return;
      }
      const formattedClozeText = buildClozeText(
        clozeText,
        clozeAnswers,
        clozeSeparateCards
      );
      await withLoading(async () => {
        await onSubmit({
          cardType,
          front: formattedClozeText.trim(),
          back: '',
          fields: {},
          tags: tagsInput,
          reversed: false,
        });
      });
    } else {
      if (fieldNeedsLabel(front, frontType)) {
        setError('Add a label for the front (used for search).');
        return;
      }
      if (fieldNeedsLabel(back, backType)) {
        setError('Add a label for the back (used for search).');
        return;
      }
      if (!fieldHasContent(front, frontType) || !fieldHasContent(back, backType)) {
        setError('Fill in both front and back.');
        return;
      }
      await withLoading(async () => {
        const resolvedFront = await resolvePendingMediaInHtml(front);
        const resolvedBack = await resolvePendingMediaInHtml(back);
        await onSubmit({
          cardType,
          front: resolvedFront,
          back: resolvedBack,
          fields: {},
          tags: tagsInput,
          reversed: editReversed,
        });
      });
    }
  }

  const defaultSubmitLabel = mode === 'create' ? 'Add' : 'Save';

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {mode === 'create' && (
        <div className="flex flex-wrap gap-1 text-xs">
          {(['basic', 'cloze'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => selectCardType(type)}
              className={`rounded-md px-3 py-1.5 ${
                cardType === type
                  ? 'bg-neutral-100 text-neutral-900'
                  : 'border border-neutral-700 text-neutral-400'
              }`}
            >
              {type === 'basic' ? 'Basic' : 'Cloze'}
            </button>
          ))}
          {noteTypes?.map((nt) => (
            <button
              key={nt.id}
              type="button"
              onClick={() => selectCardType(nt.id)}
              className={`rounded-md px-3 py-1.5 ${
                cardType === nt.id
                  ? 'bg-neutral-100 text-neutral-900'
                  : 'border border-neutral-700 text-neutral-400'
              }`}
            >
              {nt.name}
            </button>
          ))}
        </div>
      )}

      {selectedNoteType ? (
        <>
          {selectedNoteType.questionFields.map((fieldName) => {
            const isDynamic =
              (selectedNoteType.fieldTypes?.[fieldName] ?? 'richtext') === 'dynamic';
            const type = resolvedFieldType(fieldName);
            return (
              <div key={fieldName + '-q'}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-neutral-500">
                    {fieldName}
                    <span className="text-neutral-600 font-medium"> (question)</span>
                  </span>
                  {isDynamic && (
                    <FieldTypeToggle
                      value={type}
                      onChange={(t) => {
                        setDynamicFieldTypes((f) => ({
                          ...f,
                          [fieldName]: t,
                        }));
                        setFieldValues((f) => ({
                          ...f,
                          [fieldName]: '',
                        }));
                      }}
                    />
                  )}
                </div>
                <div className="mt-0.5">
                  <FieldValueInput
                    type={type}
                    value={fieldValues[fieldName] ?? ''}
                    onChange={(html) => {
                      setFieldValues((f) => ({
                        ...f,
                        [fieldName]: html,
                      }));
                      setError('');
                    }}
                  />
                </div>
              </div>
            );
          })}
          {(selectedNoteType.questionFields.length > 1 ||
            selectedNoteType.answerFields.length > 1) && (
            <hr className="border-neutral-800 my-1" />
          )}
          {selectedNoteType.answerFields.map((fieldName) => {
            const isDynamic =
              (selectedNoteType.fieldTypes?.[fieldName] ?? 'richtext') === 'dynamic';
            const type = resolvedFieldType(fieldName);
            return (
              <div key={fieldName + '-a'}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-neutral-500">
                    {fieldName}
                    <span className="text-neutral-600 font-medium"> (answer)</span>
                  </span>
                  {isDynamic && (
                    <FieldTypeToggle
                      value={type}
                      onChange={(t) => {
                        setDynamicFieldTypes((f) => ({
                          ...f,
                          [fieldName]: t,
                        }));
                        setFieldValues((f) => ({
                          ...f,
                          [fieldName]: '',
                        }));
                      }}
                    />
                  )}
                </div>
                <div className="mt-0.5">
                  <FieldValueInput
                    type={type}
                    value={fieldValues[fieldName] ?? ''}
                    onChange={(html) => {
                      setFieldValues((f) => ({
                        ...f,
                        [fieldName]: html,
                      }));
                      setError('');
                    }}
                  />
                </div>
              </div>
            );
          })}
          {selectedNoteType.reversed && (
            <label className="flex w-fit items-center gap-2 text-xs text-neutral-400">
              <Checkbox checked={editReversed} onChange={setEditReversed} />
              Also add the reverse card (answer → question)
            </label>
          )}
        </>
      ) : cardType === 'cloze' ? (
        <ClozeEditor
          initialText={clozeText}
          initialAnswers={clozeAnswers}
          initialSeparateCards={clozeSeparateCards}
          onChange={(text, answers, separateCards) => {
            setClozeText(text);
            setClozeAnswers(answers);
            setClozeSeparateCards(separateCards);
            setError('');
          }}
        />
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-neutral-500">Front</span>
              <FieldTypeToggle
                value={frontType}
                onChange={(t) => {
                  setFrontType(t);
                  setFront('');
                }}
              />
            </div>
            <div className="mt-0.5">
              <FieldValueInput
                type={frontType}
                value={front}
                onChange={(html) => {
                  setFront(html);
                  setError('');
                }}
                placeholder="e.g. 猫"
              />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-neutral-500">Back</span>
              <FieldTypeToggle
                value={backType}
                onChange={(t) => {
                  setBackType(t);
                  setBack('');
                }}
              />
            </div>
            <div className="mt-0.5">
              <FieldValueInput
                type={backType}
                value={back}
                onChange={(html) => {
                  setBack(html);
                  setError('');
                }}
                placeholder="e.g. cat"
              />
            </div>
          </div>
          {cardType === 'basic' && (
            <label className="flex w-fit items-center gap-2 text-xs text-neutral-400">
              <Checkbox checked={editReversed} onChange={setEditReversed} />
              Also add the reverse card (answer → question)
            </label>
          )}
        </>
      )}

      <TagsInput
        value={tagsInput}
        onChange={setTagsInput}
        placeholder="Type a tag, press Enter…"
      />

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          className="flex-1 rounded-md bg-neutral-100 py-1.5 text-xs font-medium text-neutral-900"
        >
          {submitLabel || defaultSubmitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
