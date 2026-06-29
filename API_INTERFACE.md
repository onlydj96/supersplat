# SuperSplat 3D 공연장 투어 연동 명세서

**프로젝트**: 스페이스홍 (spacehong.com)
**작성 목적**: Vercel 배포 환경에서 SuperSplat Viewer iframe 연동을 위한 작업 요청 자료
**참고 문서**: [PlayCanvas SuperSplat Viewer 공식 문서](https://developer.playcanvas.com/user-manual/supersplat/viewer/embedding/)

---

## 1. 현황 요약

### 현재 구현 상태

| 항목 | 상태 |
|------|------|
| `/tour` 페이지 라우트 | 완료 |
| 내비게이션 메뉴에 `3D 공연장 투어` 추가 | 완료 |
| iframe 마운트 영역 (TourPage.jsx) | 완료 |
| SuperSplat iframe `src` URL | **미설정** (placeholder) |
| 공연장 .splat/.ply 파일 | **미제공** |
| settings.json 설정 | **미작성** |

### 현재 iframe 코드 위치

```
spacehong-form-frontend/src/pages/TourPage.jsx
```

현재 `src`는 아래와 같이 임시로 설정되어 있으며, **실제 파일 URL로 교체 필요**:

```jsx
<iframe
  src="https://supersplat.playcanvas.com/viewer"
  title="스페이스홍 3D 공연장 투어"
  allow="fullscreen"
/>
```

---

## 2. SuperSplat 연동 방식 선택

아래 두 가지 방식 중 하나를 선택해야 합니다.

### 방식 A. 호스팅된 뷰어 사용 (권장 — 빠른 구현)

PlayCanvas가 운영하는 `supersplat.playcanvas.com/viewer`에 URL 파라미터로 파일 경로를 전달.

```
https://supersplat.playcanvas.com/viewer?content=<파일_URL>
```

**장점**: 별도 서버 설정 불필요, 즉시 사용 가능
**단점**: PlayCanvas 서버 가용성에 의존, iframe 내부 UI 커스터마이징 제한

**적용 예시 (TourPage.jsx)**:
```jsx
const SPLAT_URL = 'https://[호스팅_도메인]/splat/spacehong-hall.compressed.ply';

<iframe
  src={`https://supersplat.playcanvas.com/viewer?content=${encodeURIComponent(SPLAT_URL)}&noui&poster=${encodeURIComponent(POSTER_URL)}`}
  allow="fullscreen"
/>
```

---

### 방식 B. 자체 호스팅 (Self-host)

SuperSplat Editor에서 **HTML Export**하여 생성된 단일 `.html` 파일을 Vercel `/public` 디렉토리에 배치.

```
/public/tour/index.html          ← SuperSplat HTML Export 파일
/public/tour/scene.compressed.ply ← 3D 스플랫 파일
/public/tour/settings.json        ← 뷰어 설정 파일
```

**iframe src**:
```jsx
<iframe src="/tour/index.html" allow="fullscreen" />
```

**장점**: 완전한 커스터마이징, PlayCanvas 서버 의존 없음
**단점**: SuperSplat Editor에서 직접 export 작업 필요

---

## 3. 필요한 파일 목록

### 3-1. 필수 파일

| 파일 | 형식 | 설명 |
|------|------|------|
| 공연장 3D 스캔 데이터 | `.ply` 또는 `.compressed.ply` | 가우시안 스플랫 3D 공간 데이터 |
| 로딩 포스터 이미지 | `.jpg` / `.webp` (1920×1080 권장) | 3D 뷰어 로딩 전 표시되는 미리보기 이미지 |

### 3-2. 선택 파일

| 파일 | 형식 | 설명 |
|------|------|------|
| 설정 파일 | `settings.json` | 카메라 초기 위치, 조명, 후처리 효과 등 |
| 환경 이미지 | 등장방향 `.jpg` | 배경 스카이박스 이미지 |

---

## 4. URL 파라미터 명세

방식 A 사용 시, iframe src에 아래 파라미터를 조합합니다.

| 파라미터 | 타입 | 설명 | 예시 |
|----------|------|------|------|
| `content` | URL (string) | 스플랫 파일 경로 | `?content=https://cdn.../hall.ply` |
| `settings` | URL (string) | settings.json 경로 | `&settings=https://cdn.../settings.json` |
| `poster` | URL (string) | 로딩 화면 이미지 | `&poster=https://cdn.../poster.jpg` |
| `skybox` | URL (string) | 배경 스카이박스 이미지 | `&skybox=https://cdn.../sky.jpg` |
| `noui` | flag | 뷰어 내부 UI 숨기기 | `&noui` |
| `noanim` | flag | 애니메이션 일시정지 상태로 시작 | `&noanim` |
| `nofx` | flag | 후처리 효과 비활성화 | `&nofx` |
| `webgl` | flag | WebGL 강제 사용 (WebGPU 비활성) | `&webgl` |
| `aa` | flag | 안티앨리어싱 활성화 (WebGL only) | `&aa` |

**최소 권장 URL 예시**:
```
https://supersplat.playcanvas.com/viewer
  ?content=https://[CDN_도메인]/spacehong-hall.compressed.ply
  &poster=https://[CDN_도메인]/spacehong-poster.jpg
  &noui
```

---

## 5. settings.json 구조 (선택)

카메라 초기 위치, 조명, 후처리 효과를 제어하려면 settings.json을 제공합니다.

```json
{
  "version": 2,
  "tonemapping": "aces2",
  "highPrecisionRendering": false,
  "background": {
    "color": [0.05, 0.05, 0.05]
  },
  "postEffectSettings": {
    "sharpness": { "enabled": true, "amount": 0.5 },
    "bloom": { "enabled": true, "intensity": 0.3, "blurLevel": 4 },
    "grading": {
      "enabled": true,
      "brightness": 1.0,
      "contrast": 1.05,
      "saturation": 1.0,
      "tint": [1, 1, 1]
    },
    "vignette": { "enabled": false },
    "fringing": { "enabled": false }
  },
  "cameras": [
    {
      "position": [0, 1.5, 4],
      "target": [0, 1, 0],
      "fov": 60
    }
  ],
  "animTracks": [],
  "annotations": [],
  "startMode": "default"
}
```

> `cameras[0].position`과 `cameras[0].target`은 공연장 3D 데이터에 맞게 조정 필요합니다.

---

## 6. 파일 호스팅 방안

스플랫 파일(`.ply`)은 용량이 크므로(수백 MB 가능) 별도 스토리지 권장.

### 옵션 A. Supabase Storage (기존 인프라 활용 — 권장)

프로젝트에서 이미 Supabase를 사용 중이므로 Storage 버킷 활용 가능.

```
버킷명: tour-assets (public)
업로드 파일:
  - spacehong-hall.compressed.ply
  - spacehong-poster.jpg
  - settings.json (선택)
```

퍼블릭 URL 형식:
```
https://[SUPABASE_PROJECT_REF].supabase.co/storage/v1/object/public/tour-assets/spacehong-hall.compressed.ply
```

**CORS 설정** (Supabase Dashboard → Storage → Policies):
```json
{
  "allowedOrigins": ["https://spacehong.com", "https://supersplat.playcanvas.com"],
  "allowedMethods": ["GET"],
  "allowedHeaders": ["*"]
}
```

### 옵션 B. Vercel Public 디렉토리 (소용량 파일만)

50MB 미만 파일에 한해 `/public/tour/` 경로에 직접 배치 가능.
단, 대용량 `.ply` 파일은 Vercel 배포 한계로 **권장하지 않음**.

### 옵션 C. 외부 CDN (대용량 파일)

파일이 100MB 이상이라면 Cloudflare R2, AWS S3 등 CDN 서비스 사용.

---

## 7. 요청 작업 목록

아래 항목들에 대해 확인 또는 작업이 필요합니다.

### 7-1. 콘텐츠 준비 (클라이언트 측)

- [ ] 공연장 3D 가우시안 스플랫 촬영 및 `.ply` 파일 생성
- [ ] SuperSplat Editor에서 파일 열어 카메라 초기 위치 설정
- [ ] 로딩 포스터 이미지 준비 (공연장 전경 사진, 1920×1080)
- [ ] SuperSplat Editor에서 **방식 B 선택 시** HTML Export 진행

### 7-2. 파일 호스팅 설정 (개발 측)

- [ ] 호스팅 방식 결정 (Supabase Storage / Vercel Public / CDN)
- [ ] Supabase Storage 선택 시 — `tour-assets` 버킷 생성 및 CORS 설정
- [ ] 파일 업로드 후 퍼블릭 URL 확인
- [ ] CORS 정상 작동 여부 테스트

### 7-3. TourPage.jsx 코드 수정

현재 placeholder인 iframe src를 실제 URL로 교체:

```jsx
// src/pages/TourPage.jsx — 수정 필요 구간
const SPLAT_FILE_URL = '[실제_스플랫_파일_URL]';
const POSTER_URL = '[실제_포스터_이미지_URL]';

const viewerSrc = `https://supersplat.playcanvas.com/viewer?content=${encodeURIComponent(SPLAT_FILE_URL)}&poster=${encodeURIComponent(POSTER_URL)}&noui`;

<iframe src={viewerSrc} ... />
```

- [ ] `SPLAT_FILE_URL` 환경변수(`.env`)로 분리 — `VITE_SPLAT_URL`
- [ ] `POSTER_URL` 환경변수로 분리 — `VITE_TOUR_POSTER_URL`

### 7-4. Vercel 환경변수 설정

Vercel Dashboard → Settings → Environment Variables:

| 키 | 값 |
|----|-----|
| `VITE_SPLAT_URL` | `https://[호스팅]/spacehong-hall.compressed.ply` |
| `VITE_TOUR_POSTER_URL` | `https://[호스팅]/spacehong-poster.jpg` |

---

## 8. iframe 보안 설정 (선택)

iframe 내부에서 fullscreen, 자이로스코프 등을 허용하려면 `allow` 속성 확장:

```jsx
<iframe
  src={viewerSrc}
  allow="fullscreen; gyroscope; accelerometer"
  referrerPolicy="strict-origin-when-cross-origin"
/>
```

> `sandbox` 속성은 WebGL 렌더링을 차단할 수 있으므로 **사용하지 말 것**.

---

## 9. 참고 링크

| 자료 | URL |
|------|-----|
| SuperSplat 공식 사이트 | https://playcanvas.com/products/supersplat |
| Viewer 임베딩 문서 | https://developer.playcanvas.com/user-manual/supersplat/viewer/embedding/ |
| supersplat-viewer npm | https://www.npmjs.com/package/@playcanvas/supersplat-viewer |
| GitHub (viewer) | https://github.com/playcanvas/supersplat-viewer |
| GitHub (editor) | https://github.com/playcanvas/supersplat |
| PlayCanvas 포럼 (embed 논의) | https://forum.playcanvas.com/t/supersplat-viewer-embed-videos/39355 |

---

*이 문서는 스페이스홍 프론트엔드 프로젝트의 SuperSplat 연동 작업 요청을 위해 작성되었습니다.*
