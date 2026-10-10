교사 PC(Windows)용 실시간 통역 자막 프로그램입니다. 선생님이 한국어로 말하면 학생 언어 자막이 다른 창 위에 떠서 보이고, 학생이 모국어로 말하면 한국어로 보여줍니다.

## 이번 버전에서 바뀐 점
- **AI 허브 데이터 검색 고침**: v0.4.0 에서는 AI 허브가 "잘못된 접근입니다"로 거절하던 문제를 고쳤습니다. 실제 AI 허브 데이터로 확인했습니다.
- 상세 화면을 실제 데이터에 맞게 정리: 설명 속 HTML·표를 읽기 쉬운 글로, **파일 목록**은 파일 수·전체 크기·파일별 크기로 보여 줍니다.
- 학급 언어 버튼은 언어 이름만으로 찾습니다 (예: "러시아어" → 「다국어 일상대화 실시간 통번역 데이터」 등 4건).

## 받기 (둘 중 하나)
- **ClassroomInterpreter-Setup.exe**: 설치판. 관리자 권한 없이 선생님 계정에만 설치됩니다.
- **ClassroomInterpreter-Portable-win-x64.zip**: 설치 없는 판. 압축을 풀고 `ClassroomInterpreter.exe` 를 실행합니다.

코드 서명이 없어 **"Windows의 PC 보호"** 창이 뜨면 **추가 정보 → 실행** 을 누르세요.

## 처음 쓰는 방법
1. [Google AI Studio](https://aistudio.google.com/apikey) 에서 무료 Gemini API 키를 만듭니다.
2. 프로그램 **① API 키** 에 붙여넣고 **저장 → 연결 테스트** 를 누릅니다.
3. **② 학생 언어** 를 고르고 **수업 시작** 을 누릅니다.

자세한 사용법: [교사용 안내](https://github.com/7guwol7-max/translatorinclass/blob/HEAD/docs/TEACHER_GUIDE.md)

> 무료 등급에서는 보낸 음성·글을 Google 이 제품 개선에 쓸 수 있습니다. 학생·보호자 동의를 받고 사용하세요.
