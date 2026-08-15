import { describe, expect, it } from 'vitest';
import { isRelationshipQuestion } from '../src/schema-match.js';

describe('isRelationshipQuestion', () => {
  it('routes a question about the link itself to prose', () => {
    // The schema already states the foreign key; a join query returns rows instead of the answer.
    for (const q of [
      'how do customers and rentals relate?',
      'How are film and actor connected',
      'how does inventory link to store',
      'what is the relationship between customer and payment',
      "what's the link between rental and payment",
      'how are these tables associated',
      'and how do staff and store relate',
    ]) {
      expect(isRelationshipQuestion(q), q).toBe(true);
    }
  });

  it('leaves a question that filters by a relationship as a data question', () => {
    for (const q of [
      'show me customers related to store 1',
      'which films are linked to actor 5',
      'how many customers relate to each store',
      'list the related titles',
      'count the rentals connected to store 2',
    ]) {
      expect(isRelationshipQuestion(q), q).toBe(false);
    }
  });

  it('leaves first-person questions alone', () => {
    // The reader relating something, not two tables.
    for (const q of [
      'how do I relate this to revenue growth',
      'how do i connect to the database',
      'how do I link my account',
    ]) {
      expect(isRelationshipQuestion(q), q).toBe(false);
    }
  });
});
