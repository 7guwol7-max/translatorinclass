# 무료 모드 — 본인 Gemini API 키(BYOK)로 쓰기

> 교사가 Google AI Studio에서 **무료로 받은 본인 Gemini API 키**를 앱에 넣으면,
> 음성 받아쓰기·언어 식별·번역을 **Gemini 한 번의 호출**로 처리해서 무료 한도 안에서는 0원으로 동작한다.
> 별도 STT·번역 엔진도, 키를 보관할 중계 서버도 필요 없다.

---

## 0. 시작 전에 반드시 확인할 것 (약관·개인정보)

| 항목 | 내용 | 이 앱에 미치는 영향 |
| --- | --- | --- |
| **나이 제한** | Gemini API 추가 약관: 사용자는 만 18세 이상이어야 하며, **만 18세 미만이 대상이거나 이용할 가능성이 높은 앱·서비스에 Gemini API를 쓰면 안 됨** | 대학·성인 한국어반·다문화가족지원센터·평생교육 등 **성인 교실은 OK**. 초·중·고 교실은 약관과 충돌 소지 → 아래 대안 사용 |
| **무료 등급 데이터 사용** | 무료(Unpaid) 등급의 입력·출력은 Google 제품 개선에 쓰일 수 있고 사람이 검토할 수 있음. 민감·개인정보 입력 자제 권고 | 학생 음성·발화가 학습 데이터로 쓰일 수 있음 → 학생에게 고지·동의, 또는 결제 연결(유료 등급은 개선에 사용 안 함) |
| **용도** | AI Studio·Gemini API는 업무·전문 목적의 개발자용 | 교사가 수업 도구로 쓰는 건 업무 목적에 해당 |
| **변동성** | 무료 한도·무료 모델 목록은 예고 없이 바뀜 (2026년 Pro 모델 무료 제외 보도 등) | 모델 ID를 설정값으로, 한도 초과(429) 처리 필수 |

**초·중·고 교실이라면**: 약관 문제가 없는 **완전 로컬 무료 모드**(§8)를 쓰거나,
학교·교육청 차원에서 Google Cloud(Vertex AI) 등 **별도 계약 약관**으로 학교 사용 가능 여부를 확인한 뒤 유료로 씁니다.

---

## 1. 왜 Gemini 하나로 되나
- Gemini는 **오디오를 직접 입력**받아 받아쓰기 + 언어 판별 + 번역을 한 요청에서 처리 (멀티모달)
- **구조화 출력**(JSON 스키마 지정)으로 결과를 바로 자막 데이터로 사용
- 한 요청에서 여러 언어 번역을 동시에 받을 수 있음 → 요청 수 절약
- 앞 문장 문맥·교과 용어집을 같이 넣어 번역 품질 향상

---

## 2. 전체 흐름

```
🎤 마이크
  → VAD (@ricky0123/vad-web: 브라우저 안에서 도는 Silero VAD, 16kHz Float32)
  → 발화 구간 묶기 (최소/최대 길이, §4)
  → WAV 인코딩 → IPC로 main 프로세스에 전달
  → [Electron main] GeminiProvider: generateContent(오디오 + 지시문 + 직전 문맥 + 용어집, JSON 스키마)
  → { lang, transcript, translations[] }
  → 자막 오버레이 / 컨트롤 패널 로그
```

- **API 키는 main 프로세스에서만** 다룸. 화면(renderer)은 키를 모르고 IPC로 "이 오디오 처리해줘"만 요청
- 기존 설계의 Speech Gateway 서버는 이 모드에서는 필요 없음 (키가 교사 본인 것이므로 교사 PC에 있어도 됨)
- `providers/` 어댑터 구조는 그대로 유지 → 나중에 로컬 Whisper·유료 엔진으로 교체 가능

---

## 3. 모델 선택
- 기본값: **무료 등급에서 일일 요청 한도가 가장 넉넉한 Flash-Lite 계열 최신 안정 모델**
  (2026년 10월 기준 문서에 `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` 등이 있음 — AI Studio에서 내 키로 쓸 수 있는 모델 확인)
- 품질이 부족한 언어가 있으면 Flash 계열로 올리되, Flash는 무료 일일 한도가 훨씬 적다는 보고가 있음
- 모델 ID는 **설정 화면에서 바꿀 수 있게** (하드코딩 금지)
- 무료 한도 수치는 Google이 고정값으로 공개하지 않고 **프로젝트별로 AI Studio에 표시** → 교사가 자기 한도를 보고 앱에 입력

---

## 4. 무료 한도 안에서 버티는 설계 (요청 수 줄이기)

### 4.1 한 교시 요청 수 계산
- 교사 발화 약 30분(1,800초) + 학생 발화 약 20회
- 교사 발화를 **10초 단위**로 묶으면 → 180 + 20 = **교시당 약 200회**
- **20초 단위**로 묶으면 → 90 + 20 = **교시당 약 110회**

| 일일 요청 한도 (AI Studio에서 확인) | 10초 묶음 | 20초 묶음 |
| --- | --- | --- |
| 1,000회 | 하루 약 5교시 | 하루 약 9교시 |
| 500회 | 약 2.5교시 | 약 4.5교시 |
| 250회 | 약 1교시 | 약 2교시 |

### 4.2 절약 장치
1. **구간 묶기**: VAD가 끊은 짧은 발화를 모아 최소 길이(기본 4초) 이상, 최대 길이(기본 12초) 이하로 합쳐 1회 요청. 최소 길이를 넘긴 뒤 첫 쉼에서 전송
2. **언어 여러 개를 한 번에**: 교사 발화 1회 요청에 대상 언어 전부 번역 (언어마다 따로 요청하지 않음)
3. **교사 채널은 언어 식별 생략**: "한국어 음성"이라고 지시 → 응답 짧아지고 정확도 상승
4. **적응형 묶기**: 오늘 사용량이 한도의 70%를 넘으면 구간을 최소 8초 / 최대 20초로 늘림 → 지연은 늘지만 수업 끝까지 유지
5. **분당 한도 대응**: 요청 간격이 분당 한도를 넘지 않도록 큐로 순서 제어
6. **429(한도 초과) 처리**: 응답의 재시도 대기 시간만큼 기다리는 동안 들어온 구간은 큐에 쌓아 다음 요청에 합침. 설정에 대체 모델이 있으면 그 모델로 전환
7. **사용량 표시**: 컨트롤 패널에 `오늘 요청 132 / 1,000` 표시, 80%에서 경고

> 한도는 **프로젝트 단위**입니다. 같은 프로젝트에서 키를 여러 개 만들어도 한도는 늘지 않고,
> 한도를 피하려고 계정·프로젝트를 여러 개 만드는 건 약관 위반 소지가 있으니 하지 않습니다.

### 4.3 지연 시간
- 문장 단위 요청이라 **말이 끝난 뒤 자막이 뜸** (구간 길이 + 처리 1~3초)
- 말하는 도중 자막이 필요하면 §6 저지연 모드(실험)

---

## 5. 구현 스케치 (TypeScript, `@google/genai`)

### 5.1 받아쓰기 + 번역 요청

```ts
// apps/desktop/src/main/providers/gemini.ts
import { GoogleGenAI, Type } from '@google/genai';

// translations는 언어 코드를 키로 쓰는 객체 대신 배열로 받는다 (스키마에 동적 키를 쓰지 않기 위해)
const resultSchema = {
  type: Type.OBJECT,
  properties: {
    lang: { type: Type.STRING, description: 'Spoken language as an ISO 639-1 code, e.g. ko, vi, zh, ru' },
    transcript: { type: Type.STRING },
    translations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { lang: { type: Type.STRING }, text: { type: Type.STRING } },
        required: ['lang', 'text'],
      },
    },
  },
  required: ['lang', 'transcript', 'translations'],
};

export interface SegmentRequest {
  model: string;               // 설정값, 예: 'gemini-3.5-flash-lite'
  wavBase64: string;           // 16kHz mono WAV
  channel: 'teacher' | 'student';
  candidates: string[];        // 학생 언어 후보, 예: ['vi', 'zh', 'ru']
  targets: string[];           // 교사 발화 번역 대상, 예: ['vi', 'zh']
  context: string[];           // 직전 확정 문장 2~3개
  glossary: string;            // "광합성 = photosynthesis = quang hợp" 형식
}

export async function transcribeAndTranslate(ai: GoogleGenAI, req: SegmentRequest) {
  const task = req.channel === 'teacher'
    ? `The audio is Korean speech by a teacher in a classroom. Transcribe it, then translate it into: ${req.targets.join(', ')}.`
    : `The audio is a student speaking one of: ${req.candidates.join(', ')}. Identify the language, transcribe it, then translate it into Korean (ko).`;

  const res = await ai.models.generateContent({
    model: req.model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: req.wavBase64 } },
        { text: [
          task,
          'Use these term translations when they appear:', req.glossary,
          'Previous sentences for context (do not translate them again):', ...req.context,
          'If the audio contains no speech, return an empty transcript and no translations.',
        ].join('\n') },
      ],
    }],
    // 모델에 따라 thinking 설정을 최소로 낮추면 지연이 줄어든다 (모델 문서 확인)
    config: { responseMimeType: 'application/json', responseSchema: resultSchema },
  });
  return JSON.parse(res.text ?? '{}');
}
```

### 5.2 키 보관 (Windows는 DPAPI로 암호화)

```ts
// apps/desktop/src/main/keystore.ts
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const keyFile = () => path.join(app.getPath('userData'), 'gemini-key.bin');

export async function saveKey(apiKey: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 암호화 저장소를 사용할 수 없습니다');
  await fs.writeFile(keyFile(), safeStorage.encryptString(apiKey), { mode: 0o600 });
}

export async function loadKey(): Promise<string | null> {
  try {
    return safeStorage.decryptString(await fs.readFile(keyFile()));
  } catch {
    return null;
  }
}
```

---

## 6. 저지연 모드 (실험): Live API
- WebSocket 스트리밍 + **입력 음성 받아쓰기**(input audio transcription) → 말하는 도중 자막
- 주의
  - 무료 등급의 Live API는 **동시 세션 수가 적고**(보도상 약 3개), **어떤 Live 모델이 무료인지가 시기마다 다름**
  - 세션·연결 시간 제한이 있어 45분 수업에는 컨텍스트 압축 + 세션 재개 처리가 필요
- 설계: 앱이 내 키로 접속 테스트를 해서 **되는 경우에만 켜는 옵션**. 교사 채널만 Live, 학생 채널은 §5 방식 유지

---

## 7. 키 발급·입력 흐름 (교사 입장)
1. [Google AI Studio](https://aistudio.google.com) 로그인 → **Get API key** → 키 생성 (카드 등록 불필요)
2. 앱 첫 실행 → 설정 화면에 키 붙여넣기 → **연결 테스트**(짧은 요청 1회) → 성공하면 암호화 저장
3. AI Studio의 한도 화면에서 내 일일 요청 한도를 보고 앱에 입력 (기본값 제공)
4. 지킬 것
   - 키를 다른 교사와 공유하지 않기 (한도가 같이 깎이고 유출 위험)
   - 화면 공유·캡처에 키가 보이지 않게 (앱은 키를 `AIza…abcd`처럼 가려서 표시)
   - 유출이 의심되면 AI Studio에서 키 삭제 후 새로 발급
   - Google Cloud 콘솔에서 키를 Gemini API(Generative Language API)만 쓰도록 제한 가능

---

## 8. 무료 한도로 부족하거나 초·중·고 교실인 경우

| 방법 | 비용 | 장단점 |
| --- | --- | --- |
| **같은 키에 결제 연결** (유료 등급) | 월 수천 원~1만 원 내외 추정 (Flash-Lite 오디오 입력 100만 토큰당 약 $0.30, 오디오 1초 ≈ 25~32토큰, 월 47시간 기준) | 데이터가 제품 개선에 쓰이지 않음. **나이 제한 약관은 그대로 적용** |
| **완전 로컬 무료** (faster-whisper + NLLB-200 등) | 0원 (GPU PC 권장) | 키·약관·데이터 전송 문제 없음 → 초·중·고에 적합. 설치·성능 튜닝 부담, NLLB는 비상업 라이선스(CC-BY-NC) |
| 학교·교육청 계약 클라우드 (Vertex AI 등) | 유료 | 기관 약관으로 학교 사용 가능 여부 확인 필요 |

---

## 9. 기존 설계 대비 바뀌는 점
- Speech Gateway 서버 → 이 모드에서는 Electron main 안의 `GeminiProvider` 로 대체
- 키 관리: "서버만 키 보관" 원칙 → BYOK 모드에서는 **교사 본인 키를 교사 PC의 OS 암호화 저장소에** 보관 (개발자 키를 배포물에 넣는 것은 여전히 금지)
- 추가 파일 (예정)
  ```
  apps/desktop/src/main/providers/gemini.ts   # 받아쓰기+번역 요청
  apps/desktop/src/main/quota.ts              # 일일/분당 사용량, 429 처리, 적응형 묶기
  apps/desktop/src/main/keystore.ts           # safeStorage 키 보관
  apps/desktop/src/renderer/vad.ts            # VAD + 구간 묶기 + WAV 인코딩
  ```

---

## 참고
- Gemini API 추가 약관: <https://ai.google.dev/gemini-api/terms>
- Gemini 모델 목록: <https://ai.google.dev/gemini-api/docs/models>
- Live API 기능 안내: <https://ai.google.dev/gemini-api/docs/live-api/capabilities>
- 위 한도·가격 수치 일부는 제3자 자료 기준이며, 실제 값은 AI Studio와 공식 가격 페이지에서 확인
