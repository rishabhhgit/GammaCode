import React from 'react';
import Header from '../components/Header';
import Cart from '../components/Cart';
import Footer from '../components/Footer';

const CartPage: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-grow">
        <Cart />
      </main>
      <Footer />
    </div>
  );
};

export default CartPage;