'use client';

import { RichText } from './RichText';
import { ScrollFade } from './ScrollFade';
import { arrowify } from '@/lib/arrowify';

interface CardFacesProps {
  front: string;
  back: string;
  showBack: boolean;
  frontClassName?: string;
  backClassName?: string;
}

// The front/answer layout used during review: each side is its own
// independent scroll region (see ScrollFade) so a long front doesn't push a
// short back off screen or vice versa, with a divider only once the back is
// actually shown. Needs a bounded-height flex-column parent to work
// (ScrollFade's flex-1/min-h-0 has nothing to resolve against otherwise) —
// matches the review page's own card box (`flex flex-1 flex-col overflow-hidden`).
export function CardFaces({
  front,
  back,
  showBack,
  frontClassName = 'text-lg',
  backClassName = 'text-lg text-neutral-300',
}: CardFacesProps) {
  return (
    <>
      <ScrollFade>
        <div className="flex min-h-full flex-col items-center justify-center py-4">
          <RichText html={front} className={frontClassName} textTransform={arrowify} />
        </div>
      </ScrollFade>
      {showBack && (
        <>
          <hr className="shrink-0 border-neutral-800" />
          <ScrollFade>
            <div className="flex min-h-full flex-col items-center justify-center py-4">
              <RichText html={back} className={backClassName} textTransform={arrowify} />
            </div>
          </ScrollFade>
        </>
      )}
    </>
  );
}
