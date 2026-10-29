"""Run synthetic cases through REAL configured Ollama; report metrics, never values.
Usage: apps/local-service/.venv/bin/python scripts/benchmark-interpretation.py
Exit nonzero below 95% strict case accuracy. A safety rejection is not an accurate extraction.
"""
import asyncio
import argparse
import hashlib
import platform
from collections import Counter
import json
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'apps/local-service'))
from app.schemas.interpret import InterpretRequest
from app.services.ollama_client import OllamaClient, InterpretationError
from app.services.interpretation_service import InterpretationService


async def main(report=None):
    client = OllamaClient()
    correct, failures, elapsed = 0, Counter(), []
    cases = json.loads((Path(__file__).resolve().parents[1] / 'tests/fixtures/interpretation-cases.json').read_text())
    cases = [case for case in cases if case.get('kind') != 'fault']
    try:
        if not await client.available():
            print(json.dumps({'model': client.config.model, 'status': 'model-unavailable', 'cases_run': 0}))
            return 2
        for case in cases:
            start = time.monotonic()
            category = 'ok'
            try:
                response = await InterpretationService(client).interpret(InterpretRequest.model_validate(case['request']))
                actual = [{'fieldId': item.fieldId, 'target': item.target.model_dump()} for item in response.updates]
                actual.sort(key=lambda item: item['fieldId'])
                expected = sorted(case['expectedUpdates'], key=lambda item: item['fieldId'])
                clarified = {field for question in response.clarifications for field in question.targetFieldIds}
                if actual == expected and clarified == set(case['expectedClarificationFields']):
                    correct += 1
                else:
                    category = 'incorrect-proposal-or-clarification'
            except InterpretationError as error:
                category = error.code
            duration = round(time.monotonic() - start, 3)
            elapsed.append(duration)
            if category != 'ok': failures[category] += 1
            print(json.dumps({'case': case['id'], 'category': category, 'elapsed_seconds': duration}), flush=True)
        accuracy = correct / len(cases)
        summary = {'model': client.config.model, 'cases_run': len(cases), 'correct_cases': correct,
                   'strict_case_accuracy': accuracy, 'target_met': accuracy >= .95,
                   'total_seconds': round(sum(elapsed), 3), 'mean_seconds': round(sum(elapsed)/len(elapsed),3),
                   'max_seconds': max(elapsed), 'failures': dict(failures),
                   'python_version': platform.python_version(),
                   'prompt_sha256': hashlib.sha256((Path(__file__).resolve().parents[1] / 'apps/local-service/app/prompts/interpretation.txt').read_bytes()).hexdigest(),
                   'cases_sha256': hashlib.sha256(json.dumps(cases,sort_keys=True).encode()).hexdigest()}
        print(json.dumps(summary), flush=True)
        if report:
            Path(report).write_text(json.dumps(summary,indent=2)+'\n')
        return 0 if accuracy >= .95 else 1
    finally:
        await client.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', help='Optional path for aggregate metrics only; never writes transcripts or raw model output')
    raise SystemExit(asyncio.run(main(parser.parse_args().report)))
