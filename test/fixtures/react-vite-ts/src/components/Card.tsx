import type { ReactNode } from 'react';
import styled from 'styled-components';

const Wrapper = styled.section`
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
`;

export interface CardProps {
  title: string;
  footer?: ReactNode;
  children?: ReactNode;
}

export function Card({ title, footer, children }: CardProps) {
  return (
    <Wrapper>
      <h3>{title}</h3>
      <div className="card-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </Wrapper>
  );
}
