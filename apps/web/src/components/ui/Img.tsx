import type { ImgHTMLAttributes } from 'react';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string;
  wrapperClass?: string;
};

// Same wrapper the original image component rendered: a block span around a plain img.
export default function Img({ src, alt = '', className, wrapperClass = '', ...rest }: Props) {
  return (
    <span className={`block h-full${wrapperClass ? ` ${wrapperClass}` : ''}`}>
      <img src={src} alt={alt} className={className} {...rest} />
    </span>
  );
}
