import { useEffect, useState } from 'react';

/**
 * Whether a file is being dragged over the window.
 *
 * Opening the dropped file is the preload's work and has been since 0.2.2;
 * this only lets the window say "yes, you can drop that here" while the
 * file is still in the air, which until now it did not.
 *
 * Enter and leave events arrive for every element the pointer crosses, so
 * they are counted rather than trusted one at a time.
 */
const carriesFiles = (event: DragEvent): boolean =>
  event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes('Files');

export const useFileDragOver = (): boolean => {
  const [over, setOver] = useState(false);

  useEffect(() => {
    let depth = 0;

    const enter = (event: DragEvent): void => {
      if (carriesFiles(event)) {
        depth += 1;
        setOver(true);
      }
    };

    const leave = (event: DragEvent): void => {
      if (carriesFiles(event)) {
        depth = Math.max(0, depth - 1);

        if (depth === 0) {
          setOver(false);
        }
      }
    };

    const end = (): void => {
      depth = 0;
      setOver(false);
    };

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);

    return (): void => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    };
  }, []);

  return over;
};
