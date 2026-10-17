import React from 'react'

interface ProductCardProps {
  product: {
    id: number;
    name: string;
    price: number;
    image: string;
  };
  onAddToCart: (productId: number) => void;
}

const ProductCard: React.FC<ProductCardProps> = ({ product, onAddToCart }) => {
  return (
    <div className="border p-4 rounded-lg shadow-md">
      <img src={product.image} alt={product.name} className="w-full h-48 object-cover mb-4" />
      <h3 className="text-lg font-semibold">{product.name}</h3>
      <p className="text-gray-600">${product.price.toFixed(2)}</p>
      <button
        onClick={() => onAddToCart(product.id)}
        className="mt-4 bg-yellow-500 text-white px-4 py-2 rounded hover:bg-yellow-600"
      >
        Add to Cart
      </button>
    </div>
  );
}

export default ProductCard;